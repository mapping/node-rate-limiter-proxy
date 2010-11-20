/**
 * A very simple node.js HTTP proxy providing usage rate limiting using Redis.
 *
 * Author: Josh Devins (info@joshdevins.net, http://joshdevins.net)
 */

var sys = require("sys"),
    http = require("http"),
    url = require("url");
var redis = require("./lib/node_redis.js");

var config = {
    proxy_port: 8080,
    maxRequests: 10,
    periodInSeconds: 60
};

/**
 * Provided a key, lookup in Redis what the usage rate is and pass through if under limit. If over or at limit,
 * return an error code to the user.
 */
function lookupKeyAndProxy(request, response, key) {

    sys.log("Usage rate lookup: " + key);
    
    var keyX = "X:" + key;
    var keyY = "Y:" + key;

    // increment X and check TTL on Y
    redisClient.multi()
        .incr(keyX)
        .ttl(keyY)
        .exec(function (err, replies) {

            x = replies[0];
            y = replies[1];

            sys.log("X: " + x);
            sys.log("Y: " + y);
            
            // case 1: TTL is expired, need to set X and Y
            if (y == -1) {
                redisClient.multi()
                    .set(keyX, 1)
                    .setex(keyY, config.periodInSeconds, 0)
                    .exec();

                sys.log("TTL expired, proxying request for key: " + key);
                proxy(request, response);
                return;
            }

            // case 2: TTL is not expired, verify we are under the limit of maxRequests
            if (x > config.maxRequests) {

                // rate limit reached
                sys.log("Usage rate limit hit: " + key);

                response.writeHead(403, {
                    'X-RateLimit-MaxRequests' : config.maxRequests,
                    'X-RateLimit-Requests' : x,
                    'X-RateLimit-TTL' : y });
                response.end();

                return;
            }

            sys.log("TTL not expired, number of requests under limit, proxying request for key: " + key);
            proxy(request, response);
        });
}

/**
 * Proxy the request to the destination service.
 */
function proxy(request, response) {

    var hostSplit = request.headers.host.split(':');
    var host = hostSplit[0];
    var port = hostSplit[1];

    if (port == undefined) {
        port = {false : 80, true : 443}[request.socket.secure]
    }

    sys.log("Proxying to: " + host + ":" + port);

    var proxy = http.createClient(port, host, request.socket.secure);
    var proxy_request = proxy.request(request.method, request.url, request.headers);

    proxy_request.on('response', function(proxy_response) {
        
        proxy_response.on('data', function(chunk) {
            response.write(chunk, 'binary');
        });
      
        proxy_response.on('end', function() {
            response.end();
        });
      
        response.writeHead(proxy_response.statusCode, proxy_response.headers);
    });
    
    request.on('data', function(chunk) {
        proxy_request.write(chunk, 'binary');
    });
    
    request.on('end', function() {
        proxy_request.end();
    });
    
    proxy_request.end();
}

function serverCallback(request, response) {

    var auth = request.headers.authorization;
    //var method = request.method;
    //var uri = url.parse(request.url).pathname;
    
    var key = auth;

    lookupKeyAndProxy(request, response, key);
    
    sys.log("Done serverCallback");
}

// create Redis client
var redisClient = redis.createClient(6379, 'localhost');
redisClient.on("error", function (err) {
    sys.log("Redis connection error to " + redisClient.host + ":" + redisClient.port + " - " + err);
});

// startup server
sys.log("Starting HTTP usage rate limiter proxy server on port: " + config.proxy_port);
http.createServer(serverCallback).listen(config.proxy_port);
