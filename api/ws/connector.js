/*
 Copyright (c) 2015, Intel Corporation

 Redistribution and use in source and binary forms, with or without modification,
 are permitted provided that the following conditions are met:

 * Redistributions of source code must retain the above copyright notice,
 this list of conditions and the following disclaimer.
 * Redistributions in binary form must reproduce the above copyright notice,
 this list of conditions and the following disclaimer in the documentation
 and/or other materials provided with the distribution.

 THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR
 ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
 (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
 LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON
 ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
 SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */
"use strict";
var WebSocketClient = require('websocket').client,
    tunnel = require('tunnel'),
    utils = require('../../lib/utils').init(),
    errors = require('./errors');


var extractHostAndPortFromUrl = function(url) {
    var hostStartPosition = url.indexOf("://") + 3;
    var portStartPosition = url.lastIndexOf(":") + 1;
    return {
        host: url.substring(hostStartPosition, portStartPosition - 1),
        port: url.substring(portStartPosition),
        protocol: url.substring(0, url.indexOf("://"))
    };
};

var parseMessage = function (msg, callback) {
    try {
        var messageObject = JSON.parse(msg);
        callback(null, messageObject);
    } catch (err) {
        callback('Wrong message format, msg: ' + msg);
    }
};

function Websockets(conf) {
    var me = this;
    me.host = conf.connector.ws.host;
    me.port = conf.connector.ws.port;
    me.secure = conf.connector.ws.secure;
    me.minRetryTime = conf.connector.ws.minRetryTime;
    me.maxRetryTime = conf.connector.ws.maxRetryTime;
    me.proxy = conf.connector.ws.proxy;
    me.client =  new WebSocketClient();
    me.bindings = {};
    me.pingPongIntervalMs = conf.connector.ws.pingPongIntervalMs;
    me.enabledPingPong = conf.connector.ws.enablePingPong;
    me.lastPingTime = Date.now();
    me.lastPongTime = Date.now();
    me.pingpongInterval = null;
    me.deviceInfo = {};

    me.updateDeviceInfo = function(deviceInfo) {
        me.deviceInfo = deviceInfo;
    };
    
    me.calculateRetryTime = function() {
        if(utils.getMinutesAndSecondsFromMiliseconds(me.minRetryTime).m >= utils.getMinutesAndSecondsFromMiliseconds(me.maxRetryTime).m) {
            me.minRetryTime = me.maxRetryTime;
        } else {
            me.minRetryTime *= 2;
        }
    };

    if(me.proxy.host && me.proxy.port) {
        if(conf.connector.ws.proxy.host.substr(0,5) === 'https') {
            me.proxy.tunnelingAgent = tunnel.httpsOverHttps({
                proxy: {
                    host: conf.connector.ws.proxy.host.split('https://')[1],
                    port: conf.connector.ws.proxy.port
                }
            });
        } else {
            me.proxy.tunnelingAgent = tunnel.httpsOverHttp({
                proxy: {
                    host: conf.connector.ws.proxy.host.split('http://')[1] || conf.connector.ws.proxy.host,
                    port: conf.connector.ws.proxy.port
                }
            });
        }
    } else {
        var result = {};
        if(process.env.https_proxy) {
            result = extractHostAndPortFromUrl(process.env.https_proxy);
        } else if(process.env.http_proxy) {
            result = extractHostAndPortFromUrl(process.env.http_proxy);
        }
        if(result.protocol) {
            if(result.protocol === 'https') {
                me.proxy.tunnelingAgent = tunnel.httpsOverHttps({
                    proxy: {
                        host: result.host,
                        port: result.port
                    }
                });
            } else {
                me.proxy.tunnelingAgent = tunnel.httpsOverHttp({
                    proxy: {
                        host: result.host,
                        port: result.port
                    }
                });
            }
        }
    }

    me.client.requestOptions = {
        agent: me.proxy.tunnelingAgent
    };

    me.connect = function() {
        if(me.secure) {
            me.client.connect('wss://' + conf.connector.ws.host + ':' + conf.connector.ws.port, 'echo-protocol', null, null, me.client.requestOptions);
        } else {
            me.client.connect('ws://' + conf.connector.ws.host + ':' + conf.connector.ws.port, 'echo-protocol', null, null, me.client.requestOptions);
        }
    };

    me.reconnect = function() {
        if(me.pingpongInterval) {
            clearInterval(me.pingpongInterval);
            me.pingpongInterval = null;
        }
        me.connect();
    };

    me.pingpong = function(connection) {
        var pingMessageObject = {
            "type": "ping"
        };
        me.pingpongInterval = setInterval(function() {
            if(me.lastPongTime >= me.lastPingTime) {
                connection.sendUTF(JSON.stringify(pingMessageObject));
                me.lastPingTime = Date.now();
            } else {
                me.reconnect();
            }
        }, me.pingPongIntervalMs);
        connection.sendUTF(JSON.stringify(pingMessageObject));
    };

    me.onMessage = function(message) {
        me.bindings.handler(message);
    };

    me.listen = function() {
        me.client.on('connect', function(connection) {
            var initMessageObject = {
                "type": "device",
                "deviceId": me.deviceInfo.device_id,
                "deviceToken": me.deviceInfo.device_token
            };
            connection.sendUTF(JSON.stringify(initMessageObject));
            connection.on('close', function() {
                setTimeout(function() {
                    me.reconnect();
                }, parseInt(me.minRetryTime));
            });
            connection.on('message', function(message) {
                parseMessage(message.utf8Data, function(err, messageObject) {
                    if(!err) {
                        if(messageObject.code === errors.Success.ReceivedPong.code) {
                            me.lastPongTime = Date.now();
                        } else if(messageObject.code === errors.Success.Subscribed.code) {
                            me.minRetryTime = conf.connector.ws.minRetryTime;
                            if(me.enabledPingPong) {
                                me.pingpong(connection);
                            }
                        } else if(messageObject.code === errors.Success.ReceivedActuation.code) {
                            me.onMessage(messageObject.content);
                        } else if(messageObject.code === errors.Errors.DatabaseError.code || messageObject.code === errors.Errors.InvalidToken.code) {
                            me.calculateRetryTime(messageObject.content);
                        }
                    } else {
                        // TODO
                    }
                });
            });
        });
    };

    me.client.on('connectFailed', function(error) {
        me.calculateRetryTime(error);
        setTimeout(function() {
            me.reconnect();
        }, parseInt(me.minRetryTime));
    });

    me.bind = function (topic, handler, callback) {
        me.bindings = {
            handler: handler,
            callback: callback
        };
        me.connect();
        me.listen();
    };
}

var websocket = null;
module.exports.singleton = function (conf, deviceInfo) {
    if (!websocket) {
        websocket = new Websockets(conf, deviceInfo);
    }
    return websocket;
};
module.exports.Websockets = Websockets;

