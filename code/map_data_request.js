// MAP DATA REQUEST ///////////////////////////////////////////////////
// class to request the map data tiles from the Ingress servers
// and then pass it on to the render class for display purposes
// Uses the map data cache class to reduce network requests


window.MapDataRequest = function() {
  this.cache = new DataCache();
  this.render = new Render();
  this.debugTiles = new RenderDebugTiles();

  this.activeRequestCount = 0;
  this.requestedTiles = {};
  this.staleTileData = {};

  this.idle = false;


  // no more than this many requests in parallel
  this.MAX_REQUESTS = 4;
  // no more than this many tiles in one request
  // (the stock site seems to have no limit - i've seen ~100 for L3+ portals and a maximised browser window)
  this.MAX_TILES_PER_REQUEST = 32;

  // try to maintain at least this may tiles in each request, by reducing the number of requests as needed
  this.MIN_TILES_PER_REQUEST = 4;

  // number of times to retty a tile after a 'bad' error (i.e. not a timeout)
  this.MAX_TILE_RETRIES = 3;

  // refresh timers
  this.MOVE_REFRESH = 1; //time, after a map move (pan/zoom) before starting the refresh processing
  this.STARTUP_REFRESH = 3; //refresh time used on first load of IITC
  this.IDLE_RESUME_REFRESH = 5; //refresh time used after resuming from idle

  // after one of the above, there's an additional delay between preparing the refresh (clearing out of bounds,
  // processing cache, etc) and actually sending the first network requests
  this.DOWNLOAD_DELAY = 3;  //delay after preparing the data download before tile requests are sent


  // a short delay between one request finishing and the queue being run for the next request.
  // this gives a chance of other requests finishing, allowing better grouping of retries in new requests
  this.RUN_QUEUE_DELAY = 0.5;

  // delay before re-queueing tiles in failed requests
  this.BAD_REQUEST_REQUEUE_DELAY = 5; // longer delay before retrying a completely failed request - as in this case the servers are struggling

  // a delay before processing the queue after requeueing tiles. this gives a chance for other requests to finish
  // or other requeue actions to happen before the queue is processed, allowing better grouping of requests
  // however, the queue may be processed sooner if a previous timeout was set
  this.REQUEUE_DELAY = 1;


  this.REFRESH_CLOSE = 120;  // refresh time to use for close views z>12 when not idle and not moving
  this.REFRESH_FAR = 600;  // refresh time for far views z <= 12
  this.FETCH_TO_REFRESH_FACTOR = 2;  //refresh time is based on the time to complete a data fetch, times this value

  // ensure we have some initial map status
  this.setStatus ('startup');
}


window.MapDataRequest.prototype.start = function() {
  var savedContext = this;

  // setup idle resume function
  window.addResumeFunction ( function() { savedContext.idleResume(); } );

  // and map move start/end callbacks
  window.map.on('movestart', this.mapMoveStart, this);
  window.map.on('moveend', this.mapMoveEnd, this);


  // then set a timeout to start the first refresh
  this.refreshOnTimeout (this.STARTUP_REFRESH);
  this.setStatus ('refreshing');

  this.cache && this.cache.startExpireInterval (15);
}


window.MapDataRequest.prototype.mapMoveStart = function() {
  console.log('refresh map movestart');

  this.setStatus('paused');
  this.clearTimeout();

}

window.MapDataRequest.prototype.mapMoveEnd = function() {
  var bounds = clampLatLngBounds(map.getBounds());
  var zoom = getPortalDataZoom();

  if (this.fetchedDataParams) {
    // we have fetched (or are fetching) data...
    if (this.fetchedDataParams.mapZoom == map.getZoom() && this.fetchedDataParams.bounds.contains(bounds)) {
      // ... and the zoom level is the same and the current bounds is inside the fetched bounds
      // so, no need to fetch data. if there's time left, restore the original timeout

      var remainingTime = (this.timerExpectedTimeoutTime - new Date().getTime())/1000;

      if (remainingTime > this.MOVE_REFRESH) {
        this.setStatus('done','Map moved, but no data updates needed');
        this.refreshOnTimeout(remainingTime);
        return;
      }
    }
  }

  this.setStatus('refreshing');
  this.refreshOnTimeout(this.MOVE_REFRESH);
}

window.MapDataRequest.prototype.idleResume = function() {
  // if we have no timer set and there are no active requests, refresh has gone idle and the timer needs restarting

  if (this.idle) {
    console.log('refresh map idle resume');
    this.idle = false;
    this.setStatus('idle restart');
    this.refreshOnTimeout(this.IDLE_RESUME_REFRESH);
  }
}


window.MapDataRequest.prototype.clearTimeout = function() {

  if (this.timer) {
    console.log('cancelling existing map refresh timer');
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}

window.MapDataRequest.prototype.refreshOnTimeout = function(seconds) {
  this.clearTimeout();

  console.log('starting map refresh in '+seconds+' seconds');

  // 'this' won't be right inside the callback, so save it
  var savedContext = this;
  this.timer = setTimeout ( function() { savedContext.timer = undefined; savedContext.refresh(); }, seconds*1000);
  this.timerExpectedTimeoutTime = new Date().getTime() + seconds*1000;
}


window.MapDataRequest.prototype.setStatus = function(short,long,progress) {
  this.status = { short: short, long: long, progress: progress };
  window.renderUpdateStatus();
}


window.MapDataRequest.prototype.getStatus = function() {
  return this.status;
};


window.MapDataRequest.prototype.refresh = function() {

  // if we're idle, don't refresh
  if (window.isIdle()) {
    console.log('suspending map refresh - is idle');
    this.setStatus ('idle');
    this.idle = true;
    return;
  }

  //time the refresh cycle
  this.refreshStartTime = new Date().getTime();

  this.debugTiles.reset();

  // a 'set' to keep track of hard failures for tiles
  this.tileErrorCount = {};

  // fill tileBounds with the data needed to request each tile
  this.tileBounds = {};

  // clear the stale tile data
  this.staleTileData = {};


  var bounds = clampLatLngBounds(map.getBounds());
  var zoom = getPortalDataZoom();
  var minPortalLevel = getMinPortalLevelForZoom(zoom);

//DEBUG: resize the bounds so we only retrieve some data
//bounds = bounds.pad(-0.4);

//var debugrect = L.rectangle(bounds,{color: 'red', fill: false, weight: 4, opacity: 0.8}).addTo(map);
//setTimeout (function(){ map.removeLayer(debugrect); }, 10*1000);

  var x1 = lngToTile(bounds.getWest(), minPortalLevel);
  var x2 = lngToTile(bounds.getEast(), minPortalLevel);
  var y1 = latToTile(bounds.getNorth(), minPortalLevel);
  var y2 = latToTile(bounds.getSouth(), minPortalLevel);

  // calculate the full bounds for the data - including the part of the tiles off the screen edge
  var dataBounds = L.latLngBounds([
    [tileToLat(y2+1,minPortalLevel), tileToLng(x1,minPortalLevel)],
    [tileToLat(y1,minPortalLevel), tileToLng(x2+1,minPortalLevel)]
  ]);
//var debugrect2 = L.rectangle(dataBounds,{color: 'magenta', fill: false, weight: 4, opacity: 0.8}).addTo(map);
//setTimeout (function(){ map.removeLayer(debugrect2); }, 10*1000);

  // store the parameters used for fetching the data. used to prevent unneeded refreshes after move/zoom
  this.fetchedDataParams = { bounds: dataBounds, mapZoom: map.getZoom(), minPortalLevel: minPortalLevel };


  window.runHooks ('mapDataRefreshStart', {bounds: bounds, zoom: zoom, minPortalLevel: minPortalLevel, tileBounds: dataBounds});

  this.render.startRenderPass();
  this.render.clearPortalsBelowLevel(minPortalLevel);


  this.render.clearEntitiesOutsideBounds(dataBounds);

  this.render.updateEntityVisibility();


  console.log('requesting data tiles at zoom '+zoom+' (L'+minPortalLevel+'+ portals), map zoom is '+map.getZoom());


  this.cachedTileCount = 0;
  this.requestedTileCount = 0;
  this.successTileCount = 0;
  this.failedTileCount = 0;
  this.staleTileCount = 0;

  // y goes from left to right
  for (var y = y1; y <= y2; y++) {
    // x goes from bottom to top(?)
    for (var x = x1; x <= x2; x++) {
      var tile_id = pointToTileId(minPortalLevel, x, y);
      var latNorth = tileToLat(y,minPortalLevel);
      var latSouth = tileToLat(y+1,minPortalLevel);
      var lngWest = tileToLng(x,minPortalLevel);
      var lngEast = tileToLng(x+1,minPortalLevel);

      this.debugTiles.create(tile_id,[[latSouth,lngWest],[latNorth,lngEast]]);

      if (this.cache && this.cache.isFresh(tile_id) ) {
        // data is fresh in the cache - just render it
        this.debugTiles.setState(tile_id, 'cache-fresh');
        this.render.processTileData (this.cache.get(tile_id));
        this.cachedTileCount += 1;
      } else {

        // no fresh data

        // render the cached stale data, if we have it. this ensures *something* appears quickly when possible
        var old_data = this.cache && this.cache.get(tile_id);
        if (old_data) {
          this.render.processTileData (old_data);
        }

        // queue a request
        var boundsParams = generateBoundsParams(
          tile_id,
          latSouth,
          lngWest,
          latNorth,
          lngEast
        );

/* After some testing, this doesn't seem to actually work. The server returns the same data with and without the parameter
 * Also, closer study of the stock site code shows the parameter isn't actually set anywhere.
 * so, disabling for now...
        // however, the server does support delta requests - only returning the entities changed since a particular timestamp
        // retrieve the stale cache entry and use it, if possible
        var stale = (this.cache && this.cache.get(tile_id));
        var lastTimestamp = undefined;
        if (stale) {
          // find the timestamp of the latest entry in the stale records. the stock site appears to use the browser
          // clock, but this isn't reliable. ideally the data set should include it's retrieval timestamp, set by the
          // server, for use here. a good approximation is the highest timestamp of all entities

          for (var i in stale.gameEntities) {
            var ent = stale.gameEntities[i];
            if (lastTimestamp===undefined || ent[1] > lastTimestamp) {
              lastTimestamp = ent[1];
            }
          }

console.log('stale tile '+tile_id+': newest mtime '+lastTimestamp+(lastTimestamp?' '+new Date(lastTimestamp).toString():''));
          if (lastTimestamp) {
            // we can issue a useful delta request - store the previous data, as we can't rely on the cache still having it later
            this.staleTileData[tile_id] = stale;
            boundsParams.timestampMs = lastTimestamp;
          }
        }
*/

        this.tileBounds[tile_id] = boundsParams;
        this.requestedTileCount += 1;
      }
    }
  }

  this.setStatus ('loading');

  console.log ('done request preperation (cleared out-of-bounds and invalid for zoom, and rendered cached data)');

  if (Object.keys(this.tileBounds).length > 0) {
    // queued requests - don't start processing the download queue immediately - start it after a short delay
    this.delayProcessRequestQueue (this.DOWNLOAD_DELAY,true);
  } else {
    // all data was from the cache, nothing queued - run the queue 'immediately' so it handles the end request processing
    this.delayProcessRequestQueue (0,true);
  }
}


window.MapDataRequest.prototype.delayProcessRequestQueue = function(seconds,isFirst) {
  if (this.timer === undefined) {
    var savedContext = this;
    this.timer = setTimeout ( function() { savedContext.timer = undefined; savedContext.processRequestQueue(isFirst); }, seconds*1000 );
  }
}


window.MapDataRequest.prototype.processRequestQueue = function(isFirstPass) {

  // if nothing left in the queue, end the render. otherwise, send network requests
  if (Object.keys(this.tileBounds).length == 0) {

    this.render.endRenderPass();

    var endTime = new Date().getTime();
    var duration = (endTime - this.refreshStartTime)/1000;

    console.log('finished requesting data! (took '+duration+' seconds to complete)');

    window.runHooks ('mapDataRefreshEnd', {});

    var longStatus = 'Tiles: ' + this.cachedTileCount + ' cached, ' +
                 this.successTileCount + ' loaded, ' +
                 (this.staleTileCount ? this.staleTileCount + ' stale, ' : '') +
                 (this.failedTileCount ? this.failedTileCount + ' failed, ' : '') +
                 'in ' + duration + ' seconds';

    // refresh timer based on time to run this pass, with a minimum of REFRESH seconds
    var minRefresh = map.getZoom()>12 ? this.REFRESH_CLOSE : this.REFRESH_FAR;
    var refreshTimer = Math.max(minRefresh, duration*this.FETCH_TO_REFRESH_FACTOR);
    this.refreshOnTimeout(refreshTimer);
    this.setStatus (this.failedTileCount ? 'errors' : this.staleTileCount ? 'out of date' : 'done', longStatus);
    return;
  }


  // create a list of tiles that aren't requested over the network
  var pendingTiles = [];
  for (var id in this.tileBounds) {
    if (!(id in this.requestedTiles) ) {
      pendingTiles.push(id);
    }
  }

//  console.log('- request state: '+Object.keys(this.requestedTiles).length+' tiles in '+this.activeRequestCount+' active requests, '+pendingTiles.length+' tiles queued');


  var requestBuckets = this.MAX_REQUESTS - this.activeRequestCount;
  if (pendingTiles.length > 0 && requestBuckets > 0) {

    // the stock site calculates bucket grouping with the simplistic <8 tiles: 1 bucket, otherwise 4 buckets
    var maxBuckets = Math.ceil(pendingTiles.length/this.MIN_TILES_PER_REQUEST);

    requestBuckets = Math.min (maxBuckets, requestBuckets);

    var lastTileIndex = Math.min(requestBuckets*this.MAX_TILES_PER_REQUEST, pendingTiles.length);

    for (var bucket=0; bucket<requestBuckets; bucket++) {
      // create each request by taking tiles interleaved from the request

      var tiles = [];
      for (var i=bucket; i<lastTileIndex; i+=requestBuckets) {
        tiles.push (pendingTiles[i]);
      }

      if (tiles.length > 0) {
//        console.log('-- new request: '+tiles.length+' tiles');
        this.sendTileRequest(tiles);
      }
    }
  }


  // update status
  var pendingTileCount = this.requestedTileCount - (this.successTileCount+this.failedTileCount+this.staleTileCount);
  var longText = 'Tiles: ' + this.cachedTileCount + ' cached, ' +
                 this.successTileCount + ' loaded, ' +
                 (this.staleTileCount ? this.staleTileCount + ' stale, ' : '') +
                 (this.failedTileCount ? this.failedTileCount + ' failed, ' : '') +
                 pendingTileCount + ' remaining';

  progress = this.requestedTileCount > 0 ? (this.requestedTileCount-pendingTileCount) / this.requestedTileCount : undefined;
  this.setStatus ('loading', longText, progress);
}


window.MapDataRequest.prototype.sendTileRequest = function(tiles) {

  var boundsParamsList = [];

  for (var i in tiles) {
    var id = tiles[i];

    this.debugTiles.setState (id, 'requested');

    this.requestedTiles[id] = { staleData: this.staleTileData[id] };

    var boundsParams = this.tileBounds[id];
    if (boundsParams) {
      boundsParamsList.push (boundsParams);
    } else {
      console.warn('failed to find bounds for tile id '+id);
    }
  }

  var data = { boundsParamsList: boundsParamsList };

  this.activeRequestCount += 1;

  var savedThis = this;

  // NOTE: don't add the request with window.request.add, as we don't want the abort handling to apply to map data any more
  window.postAjax('getThinnedEntitiesV4', data, 
    function(data, textStatus, jqXHR) { savedThis.handleResponse (data, tiles, true); },  // request successful callback
    function() { savedThis.handleResponse (undefined, tiles, false); }  // request failed callback
  );
}

window.MapDataRequest.prototype.requeueTile = function(id, error) {
  if (id in this.tileBounds) {
    // tile is currently wanted...

    // first, see if the error can be ignored due to retry counts
    if (error) {
      this.tileErrorCount[id] = (this.tileErrorCount[id]||0)+1;
      if (this.tileErrorCount[id] <= this.MAX_TILE_RETRIES) {
        // retry limit low enough - clear the error flag
        error = false;
      }
    }

    if (error) {
      // if error is still true, retry limit hit. use stale data from cache if available
      var data = this.cache ? this.cache.get(id) : undefined;
      if (data) {
        // we have cached data - use it, even though it's stale
        this.debugTiles.setState (id, 'cache-stale');
        this.render.processTileData (data);
        this.staleTileCount += 1;
      } else {
        // no cached data
        this.debugTiles.setState (id, 'error');
        this.failedTileCount += 1;
      }
      // and delete from the pending requests...
      delete this.tileBounds[id];

    } else {
      // if false, was a 'timeout' or we're retrying, so unlimited retries (as the stock site does)
      this.debugTiles.setState (id, 'retrying');

      // FIXME? it's nice to move retried tiles to the end of the request queue. however, we don't actually have a
      // proper queue, just an object with guid as properties. Javascript standards don't guarantee the order of properties
      // within an object. however, all current browsers do keep property order, and new properties are added at the end.
      // therefore, delete and re-add the requeued tile and it will be added to the end of the queue
      var boundsData = this.tileBounds[id];
      delete this.tileBounds[id];
      this.tileBounds[id] = boundsData;

    }
  } // else the tile wasn't currently wanted (an old non-cancelled request) - ignore
}


window.MapDataRequest.prototype.handleResponse = function (data, tiles, success) {

  this.activeRequestCount -= 1;

  var successTiles = [];
  var errorTiles = [];
  var timeoutTiles = [];

  if (!success || !data || !data.result) {
    console.warn("Request.handleResponse: request failed - requeing...");

    //request failed - requeue all the tiles(?)

    for (var i in tiles) {
      var id = tiles[i];
      errorTiles.push(id);
      this.debugTiles.setState (id, 'request-fail');
    }

    window.runHooks('requestFinished', {success: false});

  } else {

    // TODO: use result.minLevelOfDetail ??? stock site doesn't use it yet...

    var m = data.result.map;

    for (var id in m) {
      var val = m[id];

      if ('error' in val) {
        // server returned an error for this individual data tile

        if (val.error == "TIMEOUT") {
          // TIMEOUT errors for individual tiles are 'expected'(!) - and result in a silent unlimited retries
          timeoutTiles.push (id);
        } else {
          console.warn('map data tile '+id+' failed: error=='+val.error);
          errorTiles.push (id);
          this.debugTiles.setState (id, 'tile-fail');
        }
      } else {
        // no error for this data tile - process it
        successTiles.push (id);

        var stale = this.requestedTiles[id].staleData;
        if (stale) {
//NOTE: currently this code path won't be used, as we never set the staleData to anything other than 'undefined'
          // we have stale data. therefore, a delta request was made for this tile. we need to merge the results with
          // the existing stale data before proceeding

          var dataObj = {};
          // copy all entities from the stale data...
          for (var i in stale.gameEntities||[]) {
            var ent = stale.gameEntities[i];
            dataObj[ent[0]] = { timestamp: ent[1], data: ent[2] };
          }
var oldEntityCount = Object.keys(dataObj).length;
          // and remove any entities in the deletedEntnties list
          for (var i in val.deletedEntities||[]) {
            var guid = val.deletedEntities[i];
            delete dataObj[guid];
          }
var oldEntityCount2 = Object.keys(dataObj).length;
          // then add all entities from the new data
          for (var i in val.gameEntities||[]) {
            var ent = val.gameEntities[i];
            dataObj[ent[0]] = { timestamp: ent[1], data: ent[2] };
          }
var newEntityCount = Object.keys(dataObj).length;
console.log('processed delta mapData request:'+id+': '+oldEntityCount+' original entities, '+oldEntityCount2+' after deletion, '+val.gameEntities.length+' entities in the response');

          // now reconstruct a new gameEntities array in val, with the updated data
          val.gameEntities = [];
          for (var guid in dataObj) {
            var ent = [guid, dataObj[guid].timestamp, dataObj[guid].data];
            val.gameEntities.push(ent);
          }

          // we can leave the returned 'deletedEntities' data unmodified - it's not critial to how IITC works anyway

          // also delete any staleTileData entries for this tile - no longer required
          delete this.staleTileData[id];
        }

        // store the result in the cache
        this.cache && this.cache.store (id, val);

        // if this tile was in the render list, render it
        // (requests aren't aborted when new requests are started, so it's entirely possible we don't want to render it!)
        if (id in this.tileBounds) {
          this.debugTiles.setState (id, stale?'ok-delta':'ok');

          this.render.processTileData (val);

          delete this.tileBounds[id];
          this.successTileCount += 1;

        } // else we don't want this tile (from an old non-cancelled request) - ignore
      }

    }

    window.runHooks('requestFinished', {success: true});
  }


  console.log ('getThinnedEntities status: '+tiles.length+' tiles: '+successTiles.length+' successful, '+timeoutTiles.length+' timed out, '+errorTiles.length+' failed');


  // requeue any 'timeout' tiles immediately
  if (timeoutTiles.length > 0) {
    for (var i in timeoutTiles) {
      var id = timeoutTiles[i];
      delete this.requestedTiles[id];
      this.requeueTile(id, false);
    }
  }

  // but for other errors, delay before retrying (as the server is having issues)
  if (errorTiles.length > 0) {
    //setTimeout has no way of passing the 'context' (aka 'this') to it's function
    var savedContext = this;

    setTimeout (function() {
      for (var i in errorTiles) {
        var id = errorTiles[i];
        delete savedContext.requestedTiles[id];
        savedContext.requeueTile(id, true);
      }
      savedContext.delayProcessRequestQueue(this.REQUEUE_DELAY);
    }, this.BAD_REQUEST_REQUEUE_DELAY*1000);
  }


  for (var i in successTiles) {
    var id = successTiles[i];
    delete this.requestedTiles[id];
  }

  //.. should this also be delayed a small amount?
  this.delayProcessRequestQueue(this.RUN_QUEUE_DELAY);
}
