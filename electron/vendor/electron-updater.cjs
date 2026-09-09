"use strict";
var __getOwnPropNames = Object.getOwnPropertyNames;
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};

// node_modules/.pnpm/universalify@2.0.1/node_modules/universalify/index.js
var require_universalify = __commonJS({
  "node_modules/.pnpm/universalify@2.0.1/node_modules/universalify/index.js"(exports2) {
    "use strict";
    exports2.fromCallback = function(fn) {
      return Object.defineProperty(function(...args) {
        if (typeof args[args.length - 1] === "function") fn.apply(this, args);
        else {
          return new Promise((resolve, reject) => {
            args.push((err, res) => err != null ? reject(err) : resolve(res));
            fn.apply(this, args);
          });
        }
      }, "name", { value: fn.name });
    };
    exports2.fromPromise = function(fn) {
      return Object.defineProperty(function(...args) {
        const cb = args[args.length - 1];
        if (typeof cb !== "function") return fn.apply(this, args);
        else {
          args.pop();
          fn.apply(this, args).then((r) => cb(null, r), cb);
        }
      }, "name", { value: fn.name });
    };
  }
});

// node_modules/.pnpm/graceful-fs@4.2.11/node_modules/graceful-fs/polyfills.js
var require_polyfills = __commonJS({
  "node_modules/.pnpm/graceful-fs@4.2.11/node_modules/graceful-fs/polyfills.js"(exports2, module2) {
    var constants = require("constants");
    var origCwd = process.cwd;
    var cwd = null;
    var platform = process.env.GRACEFUL_FS_PLATFORM || process.platform;
    process.cwd = function() {
      if (!cwd)
        cwd = origCwd.call(process);
      return cwd;
    };
    try {
      process.cwd();
    } catch (er) {
    }
    if (typeof process.chdir === "function") {
      chdir = process.chdir;
      process.chdir = function(d) {
        cwd = null;
        chdir.call(process, d);
      };
      if (Object.setPrototypeOf) Object.setPrototypeOf(process.chdir, chdir);
    }
    var chdir;
    module2.exports = patch;
    function patch(fs) {
      if (constants.hasOwnProperty("O_SYMLINK") && process.version.match(/^v0\.6\.[0-2]|^v0\.5\./)) {
        patchLchmod(fs);
      }
      if (!fs.lutimes) {
        patchLutimes(fs);
      }
      fs.chown = chownFix(fs.chown);
      fs.fchown = chownFix(fs.fchown);
      fs.lchown = chownFix(fs.lchown);
      fs.chmod = chmodFix(fs.chmod);
      fs.fchmod = chmodFix(fs.fchmod);
      fs.lchmod = chmodFix(fs.lchmod);
      fs.chownSync = chownFixSync(fs.chownSync);
      fs.fchownSync = chownFixSync(fs.fchownSync);
      fs.lchownSync = chownFixSync(fs.lchownSync);
      fs.chmodSync = chmodFixSync(fs.chmodSync);
      fs.fchmodSync = chmodFixSync(fs.fchmodSync);
      fs.lchmodSync = chmodFixSync(fs.lchmodSync);
      fs.stat = statFix(fs.stat);
      fs.fstat = statFix(fs.fstat);
      fs.lstat = statFix(fs.lstat);
      fs.statSync = statFixSync(fs.statSync);
      fs.fstatSync = statFixSync(fs.fstatSync);
      fs.lstatSync = statFixSync(fs.lstatSync);
      if (fs.chmod && !fs.lchmod) {
        fs.lchmod = function(path2, mode, cb) {
          if (cb) process.nextTick(cb);
        };
        fs.lchmodSync = function() {
        };
      }
      if (fs.chown && !fs.lchown) {
        fs.lchown = function(path2, uid, gid, cb) {
          if (cb) process.nextTick(cb);
        };
        fs.lchownSync = function() {
        };
      }
      if (platform === "win32") {
        fs.rename = typeof fs.rename !== "function" ? fs.rename : (function(fs$rename) {
          function rename(from, to, cb) {
            var start = Date.now();
            var backoff = 0;
            fs$rename(from, to, function CB(er) {
              if (er && (er.code === "EACCES" || er.code === "EPERM" || er.code === "EBUSY") && Date.now() - start < 6e4) {
                setTimeout(function() {
                  fs.stat(to, function(stater, st) {
                    if (stater && stater.code === "ENOENT")
                      fs$rename(from, to, CB);
                    else
                      cb(er);
                  });
                }, backoff);
                if (backoff < 100)
                  backoff += 10;
                return;
              }
              if (cb) cb(er);
            });
          }
          if (Object.setPrototypeOf) Object.setPrototypeOf(rename, fs$rename);
          return rename;
        })(fs.rename);
      }
      fs.read = typeof fs.read !== "function" ? fs.read : (function(fs$read) {
        function read(fd, buffer, offset, length, position, callback_) {
          var callback;
          if (callback_ && typeof callback_ === "function") {
            var eagCounter = 0;
            callback = function(er, _, __) {
              if (er && er.code === "EAGAIN" && eagCounter < 10) {
                eagCounter++;
                return fs$read.call(fs, fd, buffer, offset, length, position, callback);
              }
              callback_.apply(this, arguments);
            };
          }
          return fs$read.call(fs, fd, buffer, offset, length, position, callback);
        }
        if (Object.setPrototypeOf) Object.setPrototypeOf(read, fs$read);
        return read;
      })(fs.read);
      fs.readSync = typeof fs.readSync !== "function" ? fs.readSync : /* @__PURE__ */ (function(fs$readSync) {
        return function(fd, buffer, offset, length, position) {
          var eagCounter = 0;
          while (true) {
            try {
              return fs$readSync.call(fs, fd, buffer, offset, length, position);
            } catch (er) {
              if (er.code === "EAGAIN" && eagCounter < 10) {
                eagCounter++;
                continue;
              }
              throw er;
            }
          }
        };
      })(fs.readSync);
      function patchLchmod(fs2) {
        fs2.lchmod = function(path2, mode, callback) {
          fs2.open(
            path2,
            constants.O_WRONLY | constants.O_SYMLINK,
            mode,
            function(err, fd) {
              if (err) {
                if (callback) callback(err);
                return;
              }
              fs2.fchmod(fd, mode, function(err2) {
                fs2.close(fd, function(err22) {
                  if (callback) callback(err2 || err22);
                });
              });
            }
          );
        };
        fs2.lchmodSync = function(path2, mode) {
          var fd = fs2.openSync(path2, constants.O_WRONLY | constants.O_SYMLINK, mode);
          var threw = true;
          var ret;
          try {
            ret = fs2.fchmodSync(fd, mode);
            threw = false;
          } finally {
            if (threw) {
              try {
                fs2.closeSync(fd);
              } catch (er) {
              }
            } else {
              fs2.closeSync(fd);
            }
          }
          return ret;
        };
      }
      function patchLutimes(fs2) {
        if (constants.hasOwnProperty("O_SYMLINK") && fs2.futimes) {
          fs2.lutimes = function(path2, at, mt, cb) {
            fs2.open(path2, constants.O_SYMLINK, function(er, fd) {
              if (er) {
                if (cb) cb(er);
                return;
              }
              fs2.futimes(fd, at, mt, function(er2) {
                fs2.close(fd, function(er22) {
                  if (cb) cb(er2 || er22);
                });
              });
            });
          };
          fs2.lutimesSync = function(path2, at, mt) {
            var fd = fs2.openSync(path2, constants.O_SYMLINK);
            var ret;
            var threw = true;
            try {
              ret = fs2.futimesSync(fd, at, mt);
              threw = false;
            } finally {
              if (threw) {
                try {
                  fs2.closeSync(fd);
                } catch (er) {
                }
              } else {
                fs2.closeSync(fd);
              }
            }
            return ret;
          };
        } else if (fs2.futimes) {
          fs2.lutimes = function(_a, _b, _c, cb) {
            if (cb) process.nextTick(cb);
          };
          fs2.lutimesSync = function() {
          };
        }
      }
      function chmodFix(orig) {
        if (!orig) return orig;
        return function(target, mode, cb) {
          return orig.call(fs, target, mode, function(er) {
            if (chownErOk(er)) er = null;
            if (cb) cb.apply(this, arguments);
          });
        };
      }
      function chmodFixSync(orig) {
        if (!orig) return orig;
        return function(target, mode) {
          try {
            return orig.call(fs, target, mode);
          } catch (er) {
            if (!chownErOk(er)) throw er;
          }
        };
      }
      function chownFix(orig) {
        if (!orig) return orig;
        return function(target, uid, gid, cb) {
          return orig.call(fs, target, uid, gid, function(er) {
            if (chownErOk(er)) er = null;
            if (cb) cb.apply(this, arguments);
          });
        };
      }
      function chownFixSync(orig) {
        if (!orig) return orig;
        return function(target, uid, gid) {
          try {
            return orig.call(fs, target, uid, gid);
          } catch (er) {
            if (!chownErOk(er)) throw er;
          }
        };
      }
      function statFix(orig) {
        if (!orig) return orig;
        return function(target, options, cb) {
          if (typeof options === "function") {
            cb = options;
            options = null;
          }
          function callback(er, stats) {
            if (stats) {
              if (stats.uid < 0) stats.uid += 4294967296;
              if (stats.gid < 0) stats.gid += 4294967296;
            }
            if (cb) cb.apply(this, arguments);
          }
          return options ? orig.call(fs, target, options, callback) : orig.call(fs, target, callback);
        };
      }
      function statFixSync(orig) {
        if (!orig) return orig;
        return function(target, options) {
          var stats = options ? orig.call(fs, target, options) : orig.call(fs, target);
          if (stats) {
            if (stats.uid < 0) stats.uid += 4294967296;
            if (stats.gid < 0) stats.gid += 4294967296;
          }
          return stats;
        };
      }
      function chownErOk(er) {
        if (!er)
          return true;
        if (er.code === "ENOSYS")
          return true;
        var nonroot = !process.getuid || process.getuid() !== 0;
        if (nonroot) {
          if (er.code === "EINVAL" || er.code === "EPERM")
            return true;
        }
        return false;
      }
    }
  }
});

// node_modules/.pnpm/graceful-fs@4.2.11/node_modules/graceful-fs/legacy-streams.js
var require_legacy_streams = __commonJS({
  "node_modules/.pnpm/graceful-fs@4.2.11/node_modules/graceful-fs/legacy-streams.js"(exports2, module2) {
    var Stream = require("stream").Stream;
    module2.exports = legacy;
    function legacy(fs) {
      return {
        ReadStream,
        WriteStream
      };
      function ReadStream(path2, options) {
        if (!(this instanceof ReadStream)) return new ReadStream(path2, options);
        Stream.call(this);
        var self2 = this;
        this.path = path2;
        this.fd = null;
        this.readable = true;
        this.paused = false;
        this.flags = "r";
        this.mode = 438;
        this.bufferSize = 64 * 1024;
        options = options || {};
        var keys = Object.keys(options);
        for (var index = 0, length = keys.length; index < length; index++) {
          var key = keys[index];
          this[key] = options[key];
        }
        if (this.encoding) this.setEncoding(this.encoding);
        if (this.start !== void 0) {
          if ("number" !== typeof this.start) {
            throw TypeError("start must be a Number");
          }
          if (this.end === void 0) {
            this.end = Infinity;
          } else if ("number" !== typeof this.end) {
            throw TypeError("end must be a Number");
          }
          if (this.start > this.end) {
            throw new Error("start must be <= end");
          }
          this.pos = this.start;
        }
        if (this.fd !== null) {
          process.nextTick(function() {
            self2._read();
          });
          return;
        }
        fs.open(this.path, this.flags, this.mode, function(err, fd) {
          if (err) {
            self2.emit("error", err);
            self2.readable = false;
            return;
          }
          self2.fd = fd;
          self2.emit("open", fd);
          self2._read();
        });
      }
      function WriteStream(path2, options) {
        if (!(this instanceof WriteStream)) return new WriteStream(path2, options);
        Stream.call(this);
        this.path = path2;
        this.fd = null;
        this.writable = true;
        this.flags = "w";
        this.encoding = "binary";
        this.mode = 438;
        this.bytesWritten = 0;
        options = options || {};
        var keys = Object.keys(options);
        for (var index = 0, length = keys.length; index < length; index++) {
          var key = keys[index];
          this[key] = options[key];
        }
        if (this.start !== void 0) {
          if ("number" !== typeof this.start) {
            throw TypeError("start must be a Number");
          }
          if (this.start < 0) {
            throw new Error("start must be >= zero");
          }
          this.pos = this.start;
        }
        this.busy = false;
        this._queue = [];
        if (this.fd === null) {
          this._open = fs.open;
          this._queue.push([this._open, this.path, this.flags, this.mode, void 0]);
          this.flush();
        }
      }
    }
  }
});

// node_modules/.pnpm/graceful-fs@4.2.11/node_modules/graceful-fs/clone.js
var require_clone = __commonJS({
  "node_modules/.pnpm/graceful-fs@4.2.11/node_modules/graceful-fs/clone.js"(exports2, module2) {
    "use strict";
    module2.exports = clone;
    var getPrototypeOf = Object.getPrototypeOf || function(obj) {
      return obj.__proto__;
    };
    function clone(obj) {
      if (obj === null || typeof obj !== "object")
        return obj;
      if (obj instanceof Object)
        var copy = { __proto__: getPrototypeOf(obj) };
      else
        var copy = /* @__PURE__ */ Object.create(null);
      Object.getOwnPropertyNames(obj).forEach(function(key) {
        Object.defineProperty(copy, key, Object.getOwnPropertyDescriptor(obj, key));
      });
      return copy;
    }
  }
});

// node_modules/.pnpm/graceful-fs@4.2.11/node_modules/graceful-fs/graceful-fs.js
var require_graceful_fs = __commonJS({
  "node_modules/.pnpm/graceful-fs@4.2.11/node_modules/graceful-fs/graceful-fs.js"(exports2, module2) {
    var fs = require("fs");
    var polyfills = require_polyfills();
    var legacy = require_legacy_streams();
    var clone = require_clone();
    var util = require("util");
    var gracefulQueue;
    var previousSymbol;
    if (typeof Symbol === "function" && typeof Symbol.for === "function") {
      gracefulQueue = /* @__PURE__ */ Symbol.for("graceful-fs.queue");
      previousSymbol = /* @__PURE__ */ Symbol.for("graceful-fs.previous");
    } else {
      gracefulQueue = "___graceful-fs.queue";
      previousSymbol = "___graceful-fs.previous";
    }
    function noop() {
    }
    function publishQueue(context, queue2) {
      Object.defineProperty(context, gracefulQueue, {
        get: function() {
          return queue2;
        }
      });
    }
    var debug = noop;
    if (util.debuglog)
      debug = util.debuglog("gfs4");
    else if (/\bgfs4\b/i.test(process.env.NODE_DEBUG || ""))
      debug = function() {
        var m = util.format.apply(util, arguments);
        m = "GFS4: " + m.split(/\n/).join("\nGFS4: ");
        console.error(m);
      };
    if (!fs[gracefulQueue]) {
      queue = global[gracefulQueue] || [];
      publishQueue(fs, queue);
      fs.close = (function(fs$close) {
        function close(fd, cb) {
          return fs$close.call(fs, fd, function(err) {
            if (!err) {
              resetQueue();
            }
            if (typeof cb === "function")
              cb.apply(this, arguments);
          });
        }
        Object.defineProperty(close, previousSymbol, {
          value: fs$close
        });
        return close;
      })(fs.close);
      fs.closeSync = (function(fs$closeSync) {
        function closeSync(fd) {
          fs$closeSync.apply(fs, arguments);
          resetQueue();
        }
        Object.defineProperty(closeSync, previousSymbol, {
          value: fs$closeSync
        });
        return closeSync;
      })(fs.closeSync);
      if (/\bgfs4\b/i.test(process.env.NODE_DEBUG || "")) {
        process.on("exit", function() {
          debug(fs[gracefulQueue]);
          require("assert").equal(fs[gracefulQueue].length, 0);
        });
      }
    }
    var queue;
    if (!global[gracefulQueue]) {
      publishQueue(global, fs[gracefulQueue]);
    }
    module2.exports = patch(clone(fs));
    if (process.env.TEST_GRACEFUL_FS_GLOBAL_PATCH && !fs.__patched) {
      module2.exports = patch(fs);
      fs.__patched = true;
    }
    function patch(fs2) {
      polyfills(fs2);
      fs2.gracefulify = patch;
      fs2.createReadStream = createReadStream;
      fs2.createWriteStream = createWriteStream;
      var fs$readFile = fs2.readFile;
      fs2.readFile = readFile;
      function readFile(path2, options, cb) {
        if (typeof options === "function")
          cb = options, options = null;
        return go$readFile(path2, options, cb);
        function go$readFile(path3, options2, cb2, startTime) {
          return fs$readFile(path3, options2, function(err) {
            if (err && (err.code === "EMFILE" || err.code === "ENFILE"))
              enqueue([go$readFile, [path3, options2, cb2], err, startTime || Date.now(), Date.now()]);
            else {
              if (typeof cb2 === "function")
                cb2.apply(this, arguments);
            }
          });
        }
      }
      var fs$writeFile = fs2.writeFile;
      fs2.writeFile = writeFile;
      function writeFile(path2, data, options, cb) {
        if (typeof options === "function")
          cb = options, options = null;
        return go$writeFile(path2, data, options, cb);
        function go$writeFile(path3, data2, options2, cb2, startTime) {
          return fs$writeFile(path3, data2, options2, function(err) {
            if (err && (err.code === "EMFILE" || err.code === "ENFILE"))
              enqueue([go$writeFile, [path3, data2, options2, cb2], err, startTime || Date.now(), Date.now()]);
            else {
              if (typeof cb2 === "function")
                cb2.apply(this, arguments);
            }
          });
        }
      }
      var fs$appendFile = fs2.appendFile;
      if (fs$appendFile)
        fs2.appendFile = appendFile;
      function appendFile(path2, data, options, cb) {
        if (typeof options === "function")
          cb = options, options = null;
        return go$appendFile(path2, data, options, cb);
        function go$appendFile(path3, data2, options2, cb2, startTime) {
          return fs$appendFile(path3, data2, options2, function(err) {
            if (err && (err.code === "EMFILE" || err.code === "ENFILE"))
              enqueue([go$appendFile, [path3, data2, options2, cb2], err, startTime || Date.now(), Date.now()]);
            else {
              if (typeof cb2 === "function")
                cb2.apply(this, arguments);
            }
          });
        }
      }
      var fs$copyFile = fs2.copyFile;
      if (fs$copyFile)
        fs2.copyFile = copyFile;
      function copyFile(src, dest, flags, cb) {
        if (typeof flags === "function") {
          cb = flags;
          flags = 0;
        }
        return go$copyFile(src, dest, flags, cb);
        function go$copyFile(src2, dest2, flags2, cb2, startTime) {
          return fs$copyFile(src2, dest2, flags2, function(err) {
            if (err && (err.code === "EMFILE" || err.code === "ENFILE"))
              enqueue([go$copyFile, [src2, dest2, flags2, cb2], err, startTime || Date.now(), Date.now()]);
            else {
              if (typeof cb2 === "function")
                cb2.apply(this, arguments);
            }
          });
        }
      }
      var fs$readdir = fs2.readdir;
      fs2.readdir = readdir;
      var noReaddirOptionVersions = /^v[0-5]\./;
      function readdir(path2, options, cb) {
        if (typeof options === "function")
          cb = options, options = null;
        var go$readdir = noReaddirOptionVersions.test(process.version) ? function go$readdir2(path3, options2, cb2, startTime) {
          return fs$readdir(path3, fs$readdirCallback(
            path3,
            options2,
            cb2,
            startTime
          ));
        } : function go$readdir2(path3, options2, cb2, startTime) {
          return fs$readdir(path3, options2, fs$readdirCallback(
            path3,
            options2,
            cb2,
            startTime
          ));
        };
        return go$readdir(path2, options, cb);
        function fs$readdirCallback(path3, options2, cb2, startTime) {
          return function(err, files) {
            if (err && (err.code === "EMFILE" || err.code === "ENFILE"))
              enqueue([
                go$readdir,
                [path3, options2, cb2],
                err,
                startTime || Date.now(),
                Date.now()
              ]);
            else {
              if (files && files.sort)
                files.sort();
              if (typeof cb2 === "function")
                cb2.call(this, err, files);
            }
          };
        }
      }
      if (process.version.substr(0, 4) === "v0.8") {
        var legStreams = legacy(fs2);
        ReadStream = legStreams.ReadStream;
        WriteStream = legStreams.WriteStream;
      }
      var fs$ReadStream = fs2.ReadStream;
      if (fs$ReadStream) {
        ReadStream.prototype = Object.create(fs$ReadStream.prototype);
        ReadStream.prototype.open = ReadStream$open;
      }
      var fs$WriteStream = fs2.WriteStream;
      if (fs$WriteStream) {
        WriteStream.prototype = Object.create(fs$WriteStream.prototype);
        WriteStream.prototype.open = WriteStream$open;
      }
      Object.defineProperty(fs2, "ReadStream", {
        get: function() {
          return ReadStream;
        },
        set: function(val) {
          ReadStream = val;
        },
        enumerable: true,
        configurable: true
      });
      Object.defineProperty(fs2, "WriteStream", {
        get: function() {
          return WriteStream;
        },
        set: function(val) {
          WriteStream = val;
        },
        enumerable: true,
        configurable: true
      });
      var FileReadStream = ReadStream;
      Object.defineProperty(fs2, "FileReadStream", {
        get: function() {
          return FileReadStream;
        },
        set: function(val) {
          FileReadStream = val;
        },
        enumerable: true,
        configurable: true
      });
      var FileWriteStream = WriteStream;
      Object.defineProperty(fs2, "FileWriteStream", {
        get: function() {
          return FileWriteStream;
        },
        set: function(val) {
          FileWriteStream = val;
        },
        enumerable: true,
        configurable: true
      });
      function ReadStream(path2, options) {
        if (this instanceof ReadStream)
          return fs$ReadStream.apply(this, arguments), this;
        else
          return ReadStream.apply(Object.create(ReadStream.prototype), arguments);
      }
      function ReadStream$open() {
        var that = this;
        open(that.path, that.flags, that.mode, function(err, fd) {
          if (err) {
            if (that.autoClose)
              that.destroy();
            that.emit("error", err);
          } else {
            that.fd = fd;
            that.emit("open", fd);
            that.read();
          }
        });
      }
      function WriteStream(path2, options) {
        if (this instanceof WriteStream)
          return fs$WriteStream.apply(this, arguments), this;
        else
          return WriteStream.apply(Object.create(WriteStream.prototype), arguments);
      }
      function WriteStream$open() {
        var that = this;
        open(that.path, that.flags, that.mode, function(err, fd) {
          if (err) {
            that.destroy();
            that.emit("error", err);
          } else {
            that.fd = fd;
            that.emit("open", fd);
          }
        });
      }
      function createReadStream(path2, options) {
        return new fs2.ReadStream(path2, options);
      }
      function createWriteStream(path2, options) {
        return new fs2.WriteStream(path2, options);
      }
      var fs$open = fs2.open;
      fs2.open = open;
      function open(path2, flags, mode, cb) {
        if (typeof mode === "function")
          cb = mode, mode = null;
        return go$open(path2, flags, mode, cb);
        function go$open(path3, flags2, mode2, cb2, startTime) {
          return fs$open(path3, flags2, mode2, function(err, fd) {
            if (err && (err.code === "EMFILE" || err.code === "ENFILE"))
              enqueue([go$open, [path3, flags2, mode2, cb2], err, startTime || Date.now(), Date.now()]);
            else {
              if (typeof cb2 === "function")
                cb2.apply(this, arguments);
            }
          });
        }
      }
      return fs2;
    }
    function enqueue(elem) {
      debug("ENQUEUE", elem[0].name, elem[1]);
      fs[gracefulQueue].push(elem);
      retry();
    }
    var retryTimer;
    function resetQueue() {
      var now = Date.now();
      for (var i = 0; i < fs[gracefulQueue].length; ++i) {
        if (fs[gracefulQueue][i].length > 2) {
          fs[gracefulQueue][i][3] = now;
          fs[gracefulQueue][i][4] = now;
        }
      }
      retry();
    }
    function retry() {
      clearTimeout(retryTimer);
      retryTimer = void 0;
      if (fs[gracefulQueue].length === 0)
        return;
      var elem = fs[gracefulQueue].shift();
      var fn = elem[0];
      var args = elem[1];
      var err = elem[2];
      var startTime = elem[3];
      var lastTime = elem[4];
      if (startTime === void 0) {
        debug("RETRY", fn.name, args);
        fn.apply(null, args);
      } else if (Date.now() - startTime >= 6e4) {
        debug("TIMEOUT", fn.name, args);
        var cb = args.pop();
        if (typeof cb === "function")
          cb.call(null, err);
      } else {
        var sinceAttempt = Date.now() - lastTime;
        var sinceStart = Math.max(lastTime - startTime, 1);
        var desiredDelay = Math.min(sinceStart * 1.2, 100);
        if (sinceAttempt >= desiredDelay) {
          debug("RETRY", fn.name, args);
          fn.apply(null, args.concat([startTime]));
        } else {
          fs[gracefulQueue].push(elem);
        }
      }
      if (retryTimer === void 0) {
        retryTimer = setTimeout(retry, 0);
      }
    }
  }
});

// node_modules/.pnpm/fs-extra@10.1.0/node_modules/fs-extra/lib/fs/index.js
var require_fs = __commonJS({
  "node_modules/.pnpm/fs-extra@10.1.0/node_modules/fs-extra/lib/fs/index.js"(exports2) {
    "use strict";
    var u = require_universalify().fromCallback;
    var fs = require_graceful_fs();
    var api = [
      "access",
      "appendFile",
      "chmod",
      "chown",
      "close",
      "copyFile",
      "fchmod",
      "fchown",
      "fdatasync",
      "fstat",
      "fsync",
      "ftruncate",
      "futimes",
      "lchmod",
      "lchown",
      "link",
      "lstat",
      "mkdir",
      "mkdtemp",
      "open",
      "opendir",
      "readdir",
      "readFile",
      "readlink",
      "realpath",
      "rename",
      "rm",
      "rmdir",
      "stat",
      "symlink",
      "truncate",
      "unlink",
      "utimes",
      "writeFile"
    ].filter((key) => {
      return typeof fs[key] === "function";
    });
    Object.assign(exports2, fs);
    api.forEach((method) => {
      exports2[method] = u(fs[method]);
    });
    exports2.exists = function(filename, callback) {
      if (typeof callback === "function") {
        return fs.exists(filename, callback);
      }
      return new Promise((resolve) => {
        return fs.exists(filename, resolve);
      });
    };
    exports2.read = function(fd, buffer, offset, length, position, callback) {
      if (typeof callback === "function") {
        return fs.read(fd, buffer, offset, length, position, callback);
      }
      return new Promise((resolve, reject) => {
        fs.read(fd, buffer, offset, length, position, (err, bytesRead, buffer2) => {
          if (err) return reject(err);
          resolve({ bytesRead, buffer: buffer2 });
        });
      });
    };
    exports2.write = function(fd, buffer, ...args) {
      if (typeof args[args.length - 1] === "function") {
        return fs.write(fd, buffer, ...args);
      }
      return new Promise((resolve, reject) => {
        fs.write(fd, buffer, ...args, (err, bytesWritten, buffer2) => {
          if (err) return reject(err);
          resolve({ bytesWritten, buffer: buffer2 });
        });
      });
    };
    if (typeof fs.writev === "function") {
      exports2.writev = function(fd, buffers, ...args) {
        if (typeof args[args.length - 1] === "function") {
          return fs.writev(fd, buffers, ...args);
        }
        return new Promise((resolve, reject) => {
          fs.writev(fd, buffers, ...args, (err, bytesWritten, buffers2) => {
            if (err) return reject(err);
            resolve({ bytesWritten, buffers: buffers2 });
          });
        });
      };
    }
    if (typeof fs.realpath.native === "function") {
      exports2.realpath.native = u(fs.realpath.native);
    } else {
      process.emitWarning(
        "fs.realpath.native is not a function. Is fs being monkey-patched?",
        "Warning",
        "fs-extra-WARN0003"
      );
    }
  }
});

// node_modules/.pnpm/fs-extra@10.1.0/node_modules/fs-extra/lib/mkdirs/utils.js
var require_utils = __commonJS({
  "node_modules/.pnpm/fs-extra@10.1.0/node_modules/fs-extra/lib/mkdirs/utils.js"(exports2, module2) {
    "use strict";
    var path2 = require("path");
    module2.exports.checkPath = function checkPath(pth) {
      if (process.platform === "win32") {
        const pathHasInvalidWinCharacters = /[<>:"|?*]/.test(pth.replace(path2.parse(pth).root, ""));
        if (pathHasInvalidWinCharacters) {
          const error = new Error(`Path contains invalid characters: ${pth}`);
          error.code = "EINVAL";
          throw error;
        }
      }
    };
  }
});

// node_modules/.pnpm/fs-extra@10.1.0/node_modules/fs-extra/lib/mkdirs/make-dir.js
var require_make_dir = __commonJS({
  "node_modules/.pnpm/fs-extra@10.1.0/node_modules/fs-extra/lib/mkdirs/make-dir.js"(exports2, module2) {
    "use strict";
    var fs = require_fs();
    var { checkPath } = require_utils();
    var getMode = (options) => {
      const defaults = { mode: 511 };
      if (typeof options === "number") return options;
      return { ...defaults, ...options }.mode;
    };
    module2.exports.makeDir = async (dir, options) => {
      checkPath(dir);
      return fs.mkdir(dir, {
        mode: getMode(options),
        recursive: true
      });
    };
    module2.exports.makeDirSync = (dir, options) => {
      checkPath(dir);
      return fs.mkdirSync(dir, {
        mode: getMode(options),
        recursive: true
      });
    };
  }
});

// node_modules/.pnpm/fs-extra@10.1.0/node_modules/fs-extra/lib/mkdirs/index.js
var require_mkdirs = __commonJS({
  "node_modules/.pnpm/fs-extra@10.1.0/node_modules/fs-extra/lib/mkdirs/index.js"(exports2, module2) {
    "use strict";
    var u = require_universalify().fromPromise;
    var { makeDir: _makeDir, makeDirSync } = require_make_dir();
    var makeDir = u(_makeDir);
    module2.exports = {
      mkdirs: makeDir,
      mkdirsSync: makeDirSync,
      // alias
      mkdirp: makeDir,
      mkdirpSync: makeDirSync,
      ensureDir: makeDir,
      ensureDirSync: makeDirSync
    };
  }
});

// node_modules/.pnpm/fs-extra@10.1.0/node_modules/fs-extra/lib/path-exists/index.js
var require_path_exists = __commonJS({
  "node_modules/.pnpm/fs-extra@10.1.0/node_modules/fs-extra/lib/path-exists/index.js"(exports2, module2) {
    "use strict";
    var u = require_universalify().fromPromise;
    var fs = require_fs();
    function pathExists(path2) {
      return fs.access(path2).then(() => true).catch(() => false);
    }
    module2.exports = {
      pathExists: u(pathExists),
      pathExistsSync: fs.existsSync
    };
  }
});

// node_modules/.pnpm/fs-extra@10.1.0/node_modules/fs-extra/lib/util/utimes.js
var require_utimes = __commonJS({
  "node_modules/.pnpm/fs-extra@10.1.0/node_modules/fs-extra/lib/util/utimes.js"(exports2, module2) {
    "use strict";
    var fs = require_graceful_fs();
    function utimesMillis(path2, atime, mtime, callback) {
      fs.open(path2, "r+", (err, fd) => {
        if (err) return callback(err);
        fs.futimes(fd, atime, mtime, (futimesErr) => {
          fs.close(fd, (closeErr) => {
            if (callback) callback(futimesErr || closeErr);
          });
        });
      });
    }
    function utimesMillisSync(path2, atime, mtime) {
      const fd = fs.openSync(path2, "r+");
      fs.futimesSync(fd, atime, mtime);
      return fs.closeSync(fd);
    }
    module2.exports = {
      utimesMillis,
      utimesMillisSync
    };
  }
});

// node_modules/.pnpm/fs-extra@10.1.0/node_modules/fs-extra/lib/util/stat.js
var require_stat = __commonJS({
  "node_modules/.pnpm/fs-extra@10.1.0/node_modules/fs-extra/lib/util/stat.js"(exports2, module2) {
    "use strict";
    var fs = require_fs();
    var path2 = require("path");
    var util = require("util");
    function getStats(src, dest, opts) {
      const statFunc = opts.dereference ? (file) => fs.stat(file, { bigint: true }) : (file) => fs.lstat(file, { bigint: true });
      return Promise.all([
        statFunc(src),
        statFunc(dest).catch((err) => {
          if (err.code === "ENOENT") return null;
          throw err;
        })
      ]).then(([srcStat, destStat]) => ({ srcStat, destStat }));
    }
    function getStatsSync(src, dest, opts) {
      let destStat;
      const statFunc = opts.dereference ? (file) => fs.statSync(file, { bigint: true }) : (file) => fs.lstatSync(file, { bigint: true });
      const srcStat = statFunc(src);
      try {
        destStat = statFunc(dest);
      } catch (err) {
        if (err.code === "ENOENT") return { srcStat, destStat: null };
        throw err;
      }
      return { srcStat, destStat };
    }
    function checkPaths(src, dest, funcName, opts, cb) {
      util.callbackify(getStats)(src, dest, opts, (err, stats) => {
        if (err) return cb(err);
        const { srcStat, destStat } = stats;
        if (destStat) {
          if (areIdentical(srcStat, destStat)) {
            const srcBaseName = path2.basename(src);
            const destBaseName = path2.basename(dest);
            if (funcName === "move" && srcBaseName !== destBaseName && srcBaseName.toLowerCase() === destBaseName.toLowerCase()) {
              return cb(null, { srcStat, destStat, isChangingCase: true });
            }
            return cb(new Error("Source and destination must not be the same."));
          }
          if (srcStat.isDirectory() && !destStat.isDirectory()) {
            return cb(new Error(`Cannot overwrite non-directory '${dest}' with directory '${src}'.`));
          }
          if (!srcStat.isDirectory() && destStat.isDirectory()) {
            return cb(new Error(`Cannot overwrite directory '${dest}' with non-directory '${src}'.`));
          }
        }
        if (srcStat.isDirectory() && isSrcSubdir(src, dest)) {
          return cb(new Error(errMsg(src, dest, funcName)));
        }
        return cb(null, { srcStat, destStat });
      });
    }
    function checkPathsSync(src, dest, funcName, opts) {
      const { srcStat, destStat } = getStatsSync(src, dest, opts);
      if (destStat) {
        if (areIdentical(srcStat, destStat)) {
          const srcBaseName = path2.basename(src);
          const destBaseName = path2.basename(dest);
          if (funcName === "move" && srcBaseName !== destBaseName && srcBaseName.toLowerCase() === destBaseName.toLowerCase()) {
            return { srcStat, destStat, isChangingCase: true };
          }
          throw new Error("Source and destination must not be the same.");
        }
        if (srcStat.isDirectory() && !destStat.isDirectory()) {
          throw new Error(`Cannot overwrite non-directory '${dest}' with directory '${src}'.`);
        }
        if (!srcStat.isDirectory() && destStat.isDirectory()) {
          throw new Error(`Cannot overwrite directory '${dest}' with non-directory '${src}'.`);
        }
      }
      if (srcStat.isDirectory() && isSrcSubdir(src, dest)) {
        throw new Error(errMsg(src, dest, funcName));
      }
      return { srcStat, destStat };
    }
    function checkParentPaths(src, srcStat, dest, funcName, cb) {
      const srcParent = path2.resolve(path2.dirname(src));
      const destParent = path2.resolve(path2.dirname(dest));
      if (destParent === srcParent || destParent === path2.parse(destParent).root) return cb();
      fs.stat(destParent, { bigint: true }, (err, destStat) => {
        if (err) {
          if (err.code === "ENOENT") return cb();
          return cb(err);
        }
        if (areIdentical(srcStat, destStat)) {
          return cb(new Error(errMsg(src, dest, funcName)));
        }
        return checkParentPaths(src, srcStat, destParent, funcName, cb);
      });
    }
    function checkParentPathsSync(src, srcStat, dest, funcName) {
      const srcParent = path2.resolve(path2.dirname(src));
      const destParent = path2.resolve(path2.dirname(dest));
      if (destParent === srcParent || destParent === path2.parse(destParent).root) return;
      let destStat;
      try {
        destStat = fs.statSync(destParent, { bigint: true });
      } catch (err) {
        if (err.code === "ENOENT") return;
        throw err;
      }
      if (areIdentical(srcStat, destStat)) {
        throw new Error(errMsg(src, dest, funcName));
      }
      return checkParentPathsSync(src, srcStat, destParent, funcName);
    }
    function areIdentical(srcStat, destStat) {
      return destStat.ino && destStat.dev && destStat.ino === srcStat.ino && destStat.dev === srcStat.dev;
    }
    function isSrcSubdir(src, dest) {
      const srcArr = path2.resolve(src).split(path2.sep).filter((i) => i);
      const destArr = path2.resolve(dest).split(path2.sep).filter((i) => i);
      return srcArr.reduce((acc, cur, i) => acc && destArr[i] === cur, true);
    }
    function errMsg(src, dest, funcName) {
      return `Cannot ${funcName} '${src}' to a subdirectory of itself, '${dest}'.`;
    }
    module2.exports = {
      checkPaths,
      checkPathsSync,
      checkParentPaths,
      checkParentPathsSync,
      isSrcSubdir,
      areIdentical
    };
  }
});

// node_modules/.pnpm/fs-extra@10.1.0/node_modules/fs-extra/lib/copy/copy.js
var require_copy = __commonJS({
  "node_modules/.pnpm/fs-extra@10.1.0/node_modules/fs-extra/lib/copy/copy.js"(exports2, module2) {
    "use strict";
    var fs = require_graceful_fs();
    var path2 = require("path");
    var mkdirs = require_mkdirs().mkdirs;
    var pathExists = require_path_exists().pathExists;
    var utimesMillis = require_utimes().utimesMillis;
    var stat = require_stat();
    function copy(src, dest, opts, cb) {
      if (typeof opts === "function" && !cb) {
        cb = opts;
        opts = {};
      } else if (typeof opts === "function") {
        opts = { filter: opts };
      }
      cb = cb || function() {
      };
      opts = opts || {};
      opts.clobber = "clobber" in opts ? !!opts.clobber : true;
      opts.overwrite = "overwrite" in opts ? !!opts.overwrite : opts.clobber;
      if (opts.preserveTimestamps && process.arch === "ia32") {
        process.emitWarning(
          "Using the preserveTimestamps option in 32-bit node is not recommended;\n\n	see https://github.com/jprichardson/node-fs-extra/issues/269",
          "Warning",
          "fs-extra-WARN0001"
        );
      }
      stat.checkPaths(src, dest, "copy", opts, (err, stats) => {
        if (err) return cb(err);
        const { srcStat, destStat } = stats;
        stat.checkParentPaths(src, srcStat, dest, "copy", (err2) => {
          if (err2) return cb(err2);
          if (opts.filter) return handleFilter(checkParentDir, destStat, src, dest, opts, cb);
          return checkParentDir(destStat, src, dest, opts, cb);
        });
      });
    }
    function checkParentDir(destStat, src, dest, opts, cb) {
      const destParent = path2.dirname(dest);
      pathExists(destParent, (err, dirExists) => {
        if (err) return cb(err);
        if (dirExists) return getStats(destStat, src, dest, opts, cb);
        mkdirs(destParent, (err2) => {
          if (err2) return cb(err2);
          return getStats(destStat, src, dest, opts, cb);
        });
      });
    }
    function handleFilter(onInclude, destStat, src, dest, opts, cb) {
      Promise.resolve(opts.filter(src, dest)).then((include) => {
        if (include) return onInclude(destStat, src, dest, opts, cb);
        return cb();
      }, (error) => cb(error));
    }
    function startCopy(destStat, src, dest, opts, cb) {
      if (opts.filter) return handleFilter(getStats, destStat, src, dest, opts, cb);
      return getStats(destStat, src, dest, opts, cb);
    }
    function getStats(destStat, src, dest, opts, cb) {
      const stat2 = opts.dereference ? fs.stat : fs.lstat;
      stat2(src, (err, srcStat) => {
        if (err) return cb(err);
        if (srcStat.isDirectory()) return onDir(srcStat, destStat, src, dest, opts, cb);
        else if (srcStat.isFile() || srcStat.isCharacterDevice() || srcStat.isBlockDevice()) return onFile(srcStat, destStat, src, dest, opts, cb);
        else if (srcStat.isSymbolicLink()) return onLink(destStat, src, dest, opts, cb);
        else if (srcStat.isSocket()) return cb(new Error(`Cannot copy a socket file: ${src}`));
        else if (srcStat.isFIFO()) return cb(new Error(`Cannot copy a FIFO pipe: ${src}`));
        return cb(new Error(`Unknown file: ${src}`));
      });
    }
    function onFile(srcStat, destStat, src, dest, opts, cb) {
      if (!destStat) return copyFile(srcStat, src, dest, opts, cb);
      return mayCopyFile(srcStat, src, dest, opts, cb);
    }
    function mayCopyFile(srcStat, src, dest, opts, cb) {
      if (opts.overwrite) {
        fs.unlink(dest, (err) => {
          if (err) return cb(err);
          return copyFile(srcStat, src, dest, opts, cb);
        });
      } else if (opts.errorOnExist) {
        return cb(new Error(`'${dest}' already exists`));
      } else return cb();
    }
    function copyFile(srcStat, src, dest, opts, cb) {
      fs.copyFile(src, dest, (err) => {
        if (err) return cb(err);
        if (opts.preserveTimestamps) return handleTimestampsAndMode(srcStat.mode, src, dest, cb);
        return setDestMode(dest, srcStat.mode, cb);
      });
    }
    function handleTimestampsAndMode(srcMode, src, dest, cb) {
      if (fileIsNotWritable(srcMode)) {
        return makeFileWritable(dest, srcMode, (err) => {
          if (err) return cb(err);
          return setDestTimestampsAndMode(srcMode, src, dest, cb);
        });
      }
      return setDestTimestampsAndMode(srcMode, src, dest, cb);
    }
    function fileIsNotWritable(srcMode) {
      return (srcMode & 128) === 0;
    }
    function makeFileWritable(dest, srcMode, cb) {
      return setDestMode(dest, srcMode | 128, cb);
    }
    function setDestTimestampsAndMode(srcMode, src, dest, cb) {
      setDestTimestamps(src, dest, (err) => {
        if (err) return cb(err);
        return setDestMode(dest, srcMode, cb);
      });
    }
    function setDestMode(dest, srcMode, cb) {
      return fs.chmod(dest, srcMode, cb);
    }
    function setDestTimestamps(src, dest, cb) {
      fs.stat(src, (err, updatedSrcStat) => {
        if (err) return cb(err);
        return utimesMillis(dest, updatedSrcStat.atime, updatedSrcStat.mtime, cb);
      });
    }
    function onDir(srcStat, destStat, src, dest, opts, cb) {
      if (!destStat) return mkDirAndCopy(srcStat.mode, src, dest, opts, cb);
      return copyDir(src, dest, opts, cb);
    }
    function mkDirAndCopy(srcMode, src, dest, opts, cb) {
      fs.mkdir(dest, (err) => {
        if (err) return cb(err);
        copyDir(src, dest, opts, (err2) => {
          if (err2) return cb(err2);
          return setDestMode(dest, srcMode, cb);
        });
      });
    }
    function copyDir(src, dest, opts, cb) {
      fs.readdir(src, (err, items) => {
        if (err) return cb(err);
        return copyDirItems(items, src, dest, opts, cb);
      });
    }
    function copyDirItems(items, src, dest, opts, cb) {
      const item = items.pop();
      if (!item) return cb();
      return copyDirItem(items, item, src, dest, opts, cb);
    }
    function copyDirItem(items, item, src, dest, opts, cb) {
      const srcItem = path2.join(src, item);
      const destItem = path2.join(dest, item);
      stat.checkPaths(srcItem, destItem, "copy", opts, (err, stats) => {
        if (err) return cb(err);
        const { destStat } = stats;
        startCopy(destStat, srcItem, destItem, opts, (err2) => {
          if (err2) return cb(err2);
          return copyDirItems(items, src, dest, opts, cb);
        });
      });
    }
    function onLink(destStat, src, dest, opts, cb) {
      fs.readlink(src, (err, resolvedSrc) => {
        if (err) return cb(err);
        if (opts.dereference) {
          resolvedSrc = path2.resolve(process.cwd(), resolvedSrc);
        }
        if (!destStat) {
          return fs.symlink(resolvedSrc, dest, cb);
        } else {
          fs.readlink(dest, (err2, resolvedDest) => {
            if (err2) {
              if (err2.code === "EINVAL" || err2.code === "UNKNOWN") return fs.symlink(resolvedSrc, dest, cb);
              return cb(err2);
            }
            if (opts.dereference) {
              resolvedDest = path2.resolve(process.cwd(), resolvedDest);
            }
            if (stat.isSrcSubdir(resolvedSrc, resolvedDest)) {
              return cb(new Error(`Cannot copy '${resolvedSrc}' to a subdirectory of itself, '${resolvedDest}'.`));
            }
            if (destStat.isDirectory() && stat.isSrcSubdir(resolvedDest, resolvedSrc)) {
              return cb(new Error(`Cannot overwrite '${resolvedDest}' with '${resolvedSrc}'.`));
            }
            return copyLink(resolvedSrc, dest, cb);
          });
        }
      });
    }
    function copyLink(resolvedSrc, dest, cb) {
      fs.unlink(dest, (err) => {
        if (err) return cb(err);
        return fs.symlink(resolvedSrc, dest, cb);
      });
    }
    module2.exports = copy;
  }
});

// node_modules/.pnpm/fs-extra@10.1.0/node_modules/fs-extra/lib/copy/copy-sync.js
var require_copy_sync = __commonJS({
  "node_modules/.pnpm/fs-extra@10.1.0/node_modules/fs-extra/lib/copy/copy-sync.js"(exports2, module2) {
    "use strict";
    var fs = require_graceful_fs();
    var path2 = require("path");
    var mkdirsSync = require_mkdirs().mkdirsSync;
    var utimesMillisSync = require_utimes().utimesMillisSync;
    var stat = require_stat();
    function copySync(src, dest, opts) {
      if (typeof opts === "function") {
        opts = { filter: opts };
      }
      opts = opts || {};
      opts.clobber = "clobber" in opts ? !!opts.clobber : true;
      opts.overwrite = "overwrite" in opts ? !!opts.overwrite : opts.clobber;
      if (opts.preserveTimestamps && process.arch === "ia32") {
        process.emitWarning(
          "Using the preserveTimestamps option in 32-bit node is not recommended;\n\n	see https://github.com/jprichardson/node-fs-extra/issues/269",
          "Warning",
          "fs-extra-WARN0002"
        );
      }
      const { srcStat, destStat } = stat.checkPathsSync(src, dest, "copy", opts);
      stat.checkParentPathsSync(src, srcStat, dest, "copy");
      return handleFilterAndCopy(destStat, src, dest, opts);
    }
    function handleFilterAndCopy(destStat, src, dest, opts) {
      if (opts.filter && !opts.filter(src, dest)) return;
      const destParent = path2.dirname(dest);
      if (!fs.existsSync(destParent)) mkdirsSync(destParent);
      return getStats(destStat, src, dest, opts);
    }
    function startCopy(destStat, src, dest, opts) {
      if (opts.filter && !opts.filter(src, dest)) return;
      return getStats(destStat, src, dest, opts);
    }
    function getStats(destStat, src, dest, opts) {
      const statSync = opts.dereference ? fs.statSync : fs.lstatSync;
      const srcStat = statSync(src);
      if (srcStat.isDirectory()) return onDir(srcStat, destStat, src, dest, opts);
      else if (srcStat.isFile() || srcStat.isCharacterDevice() || srcStat.isBlockDevice()) return onFile(srcStat, destStat, src, dest, opts);
      else if (srcStat.isSymbolicLink()) return onLink(destStat, src, dest, opts);
      else if (srcStat.isSocket()) throw new Error(`Cannot copy a socket file: ${src}`);
      else if (srcStat.isFIFO()) throw new Error(`Cannot copy a FIFO pipe: ${src}`);
      throw new Error(`Unknown file: ${src}`);
    }
    function onFile(srcStat, destStat, src, dest, opts) {
      if (!destStat) return copyFile(srcStat, src, dest, opts);
      return mayCopyFile(srcStat, src, dest, opts);
    }
    function mayCopyFile(srcStat, src, dest, opts) {
      if (opts.overwrite) {
        fs.unlinkSync(dest);
        return copyFile(srcStat, src, dest, opts);
      } else if (opts.errorOnExist) {
        throw new Error(`'${dest}' already exists`);
      }
    }
    function copyFile(srcStat, src, dest, opts) {
      fs.copyFileSync(src, dest);
      if (opts.preserveTimestamps) handleTimestamps(srcStat.mode, src, dest);
      return setDestMode(dest, srcStat.mode);
    }
    function handleTimestamps(srcMode, src, dest) {
      if (fileIsNotWritable(srcMode)) makeFileWritable(dest, srcMode);
      return setDestTimestamps(src, dest);
    }
    function fileIsNotWritable(srcMode) {
      return (srcMode & 128) === 0;
    }
    function makeFileWritable(dest, srcMode) {
      return setDestMode(dest, srcMode | 128);
    }
    function setDestMode(dest, srcMode) {
      return fs.chmodSync(dest, srcMode);
    }
    function setDestTimestamps(src, dest) {
      const updatedSrcStat = fs.statSync(src);
      return utimesMillisSync(dest, updatedSrcStat.atime, updatedSrcStat.mtime);
    }
    function onDir(srcStat, destStat, src, dest, opts) {
      if (!destStat) return mkDirAndCopy(srcStat.mode, src, dest, opts);
      return copyDir(src, dest, opts);
    }
    function mkDirAndCopy(srcMode, src, dest, opts) {
      fs.mkdirSync(dest);
      copyDir(src, dest, opts);
      return setDestMode(dest, srcMode);
    }
    function copyDir(src, dest, opts) {
      fs.readdirSync(src).forEach((item) => copyDirItem(item, src, dest, opts));
    }
    function copyDirItem(item, src, dest, opts) {
      const srcItem = path2.join(src, item);
      const destItem = path2.join(dest, item);
      const { destStat } = stat.checkPathsSync(srcItem, destItem, "copy", opts);
      return startCopy(destStat, srcItem, destItem, opts);
    }
    function onLink(destStat, src, dest, opts) {
      let resolvedSrc = fs.readlinkSync(src);
      if (opts.dereference) {
        resolvedSrc = path2.resolve(process.cwd(), resolvedSrc);
      }
      if (!destStat) {
        return fs.symlinkSync(resolvedSrc, dest);
      } else {
        let resolvedDest;
        try {
          resolvedDest = fs.readlinkSync(dest);
        } catch (err) {
          if (err.code === "EINVAL" || err.code === "UNKNOWN") return fs.symlinkSync(resolvedSrc, dest);
          throw err;
        }
        if (opts.dereference) {
          resolvedDest = path2.resolve(process.cwd(), resolvedDest);
        }
        if (stat.isSrcSubdir(resolvedSrc, resolvedDest)) {
          throw new Error(`Cannot copy '${resolvedSrc}' to a subdirectory of itself, '${resolvedDest}'.`);
        }
        if (fs.statSync(dest).isDirectory() && stat.isSrcSubdir(resolvedDest, resolvedSrc)) {
          throw new Error(`Cannot overwrite '${resolvedDest}' with '${resolvedSrc}'.`);
        }
        return copyLink(resolvedSrc, dest);
      }
    }
    function copyLink(resolvedSrc, dest) {
      fs.unlinkSync(dest);
      return fs.symlinkSync(resolvedSrc, dest);
    }
    module2.exports = copySync;
  }
});

// node_modules/.pnpm/fs-extra@10.1.0/node_modules/fs-extra/lib/copy/index.js
var require_copy2 = __commonJS({
  "node_modules/.pnpm/fs-extra@10.1.0/node_modules/fs-extra/lib/copy/index.js"(exports2, module2) {
    "use strict";
    var u = require_universalify().fromCallback;
    module2.exports = {
      copy: u(require_copy()),
      copySync: require_copy_sync()
    };
  }
});

// node_modules/.pnpm/fs-extra@10.1.0/node_modules/fs-extra/lib/remove/rimraf.js
var require_rimraf = __commonJS({
  "node_modules/.pnpm/fs-extra@10.1.0/node_modules/fs-extra/lib/remove/rimraf.js"(exports2, module2) {
    "use strict";
    var fs = require_graceful_fs();
    var path2 = require("path");
    var assert = require("assert");
    var isWindows = process.platform === "win32";
    function defaults(options) {
      const methods = [
        "unlink",
        "chmod",
        "stat",
        "lstat",
        "rmdir",
        "readdir"
      ];
      methods.forEach((m) => {
        options[m] = options[m] || fs[m];
        m = m + "Sync";
        options[m] = options[m] || fs[m];
      });
      options.maxBusyTries = options.maxBusyTries || 3;
    }
    function rimraf(p, options, cb) {
      let busyTries = 0;
      if (typeof options === "function") {
        cb = options;
        options = {};
      }
      assert(p, "rimraf: missing path");
      assert.strictEqual(typeof p, "string", "rimraf: path should be a string");
      assert.strictEqual(typeof cb, "function", "rimraf: callback function required");
      assert(options, "rimraf: invalid options argument provided");
      assert.strictEqual(typeof options, "object", "rimraf: options should be object");
      defaults(options);
      rimraf_(p, options, function CB(er) {
        if (er) {
          if ((er.code === "EBUSY" || er.code === "ENOTEMPTY" || er.code === "EPERM") && busyTries < options.maxBusyTries) {
            busyTries++;
            const time = busyTries * 100;
            return setTimeout(() => rimraf_(p, options, CB), time);
          }
          if (er.code === "ENOENT") er = null;
        }
        cb(er);
      });
    }
    function rimraf_(p, options, cb) {
      assert(p);
      assert(options);
      assert(typeof cb === "function");
      options.lstat(p, (er, st) => {
        if (er && er.code === "ENOENT") {
          return cb(null);
        }
        if (er && er.code === "EPERM" && isWindows) {
          return fixWinEPERM(p, options, er, cb);
        }
        if (st && st.isDirectory()) {
          return rmdir(p, options, er, cb);
        }
        options.unlink(p, (er2) => {
          if (er2) {
            if (er2.code === "ENOENT") {
              return cb(null);
            }
            if (er2.code === "EPERM") {
              return isWindows ? fixWinEPERM(p, options, er2, cb) : rmdir(p, options, er2, cb);
            }
            if (er2.code === "EISDIR") {
              return rmdir(p, options, er2, cb);
            }
          }
          return cb(er2);
        });
      });
    }
    function fixWinEPERM(p, options, er, cb) {
      assert(p);
      assert(options);
      assert(typeof cb === "function");
      options.chmod(p, 438, (er2) => {
        if (er2) {
          cb(er2.code === "ENOENT" ? null : er);
        } else {
          options.stat(p, (er3, stats) => {
            if (er3) {
              cb(er3.code === "ENOENT" ? null : er);
            } else if (stats.isDirectory()) {
              rmdir(p, options, er, cb);
            } else {
              options.unlink(p, cb);
            }
          });
        }
      });
    }
    function fixWinEPERMSync(p, options, er) {
      let stats;
      assert(p);
      assert(options);
      try {
        options.chmodSync(p, 438);
      } catch (er2) {
        if (er2.code === "ENOENT") {
          return;
        } else {
          throw er;
        }
      }
      try {
        stats = options.statSync(p);
      } catch (er3) {
        if (er3.code === "ENOENT") {
          return;
        } else {
          throw er;
        }
      }
      if (stats.isDirectory()) {
        rmdirSync(p, options, er);
      } else {
        options.unlinkSync(p);
      }
    }
    function rmdir(p, options, originalEr, cb) {
      assert(p);
      assert(options);
      assert(typeof cb === "function");
      options.rmdir(p, (er) => {
        if (er && (er.code === "ENOTEMPTY" || er.code === "EEXIST" || er.code === "EPERM")) {
          rmkids(p, options, cb);
        } else if (er && er.code === "ENOTDIR") {
          cb(originalEr);
        } else {
          cb(er);
        }
      });
    }
    function rmkids(p, options, cb) {
      assert(p);
      assert(options);
      assert(typeof cb === "function");
      options.readdir(p, (er, files) => {
        if (er) return cb(er);
        let n = files.length;
        let errState;
        if (n === 0) return options.rmdir(p, cb);
        files.forEach((f) => {
          rimraf(path2.join(p, f), options, (er2) => {
            if (errState) {
              return;
            }
            if (er2) return cb(errState = er2);
            if (--n === 0) {
              options.rmdir(p, cb);
            }
          });
        });
      });
    }
    function rimrafSync(p, options) {
      let st;
      options = options || {};
      defaults(options);
      assert(p, "rimraf: missing path");
      assert.strictEqual(typeof p, "string", "rimraf: path should be a string");
      assert(options, "rimraf: missing options");
      assert.strictEqual(typeof options, "object", "rimraf: options should be object");
      try {
        st = options.lstatSync(p);
      } catch (er) {
        if (er.code === "ENOENT") {
          return;
        }
        if (er.code === "EPERM" && isWindows) {
          fixWinEPERMSync(p, options, er);
        }
      }
      try {
        if (st && st.isDirectory()) {
          rmdirSync(p, options, null);
        } else {
          options.unlinkSync(p);
        }
      } catch (er) {
        if (er.code === "ENOENT") {
          return;
        } else if (er.code === "EPERM") {
          return isWindows ? fixWinEPERMSync(p, options, er) : rmdirSync(p, options, er);
        } else if (er.code !== "EISDIR") {
          throw er;
        }
        rmdirSync(p, options, er);
      }
    }
    function rmdirSync(p, options, originalEr) {
      assert(p);
      assert(options);
      try {
        options.rmdirSync(p);
      } catch (er) {
        if (er.code === "ENOTDIR") {
          throw originalEr;
        } else if (er.code === "ENOTEMPTY" || er.code === "EEXIST" || er.code === "EPERM") {
          rmkidsSync(p, options);
        } else if (er.code !== "ENOENT") {
          throw er;
        }
      }
    }
    function rmkidsSync(p, options) {
      assert(p);
      assert(options);
      options.readdirSync(p).forEach((f) => rimrafSync(path2.join(p, f), options));
      if (isWindows) {
        const startTime = Date.now();
        do {
          try {
            const ret = options.rmdirSync(p, options);
            return ret;
          } catch {
          }
        } while (Date.now() - startTime < 500);
      } else {
        const ret = options.rmdirSync(p, options);
        return ret;
      }
    }
    module2.exports = rimraf;
    rimraf.sync = rimrafSync;
  }
});

// node_modules/.pnpm/fs-extra@10.1.0/node_modules/fs-extra/lib/remove/index.js
var require_remove = __commonJS({
  "node_modules/.pnpm/fs-extra@10.1.0/node_modules/fs-extra/lib/remove/index.js"(exports2, module2) {
    "use strict";
    var fs = require_graceful_fs();
    var u = require_universalify().fromCallback;
    var rimraf = require_rimraf();
    function remove(path2, callback) {
      if (fs.rm) return fs.rm(path2, { recursive: true, force: true }, callback);
      rimraf(path2, callback);
    }
    function removeSync(path2) {
      if (fs.rmSync) return fs.rmSync(path2, { recursive: true, force: true });
      rimraf.sync(path2);
    }
    module2.exports = {
      remove: u(remove),
      removeSync
    };
  }
});

// node_modules/.pnpm/fs-extra@10.1.0/node_modules/fs-extra/lib/empty/index.js
var require_empty = __commonJS({
  "node_modules/.pnpm/fs-extra@10.1.0/node_modules/fs-extra/lib/empty/index.js"(exports2, module2) {
    "use strict";
    var u = require_universalify().fromPromise;
    var fs = require_fs();
    var path2 = require("path");
    var mkdir = require_mkdirs();
    var remove = require_remove();
    var emptyDir = u(async function emptyDir2(dir) {
      let items;
      try {
        items = await fs.readdir(dir);
      } catch {
        return mkdir.mkdirs(dir);
      }
      return Promise.all(items.map((item) => remove.remove(path2.join(dir, item))));
    });
    function emptyDirSync(dir) {
      let items;
      try {
        items = fs.readdirSync(dir);
      } catch {
        return mkdir.mkdirsSync(dir);
      }
      items.forEach((item) => {
        item = path2.join(dir, item);
        remove.removeSync(item);
      });
    }
    module2.exports = {
      emptyDirSync,
      emptydirSync: emptyDirSync,
      emptyDir,
      emptydir: emptyDir
    };
  }
});

// node_modules/.pnpm/fs-extra@10.1.0/node_modules/fs-extra/lib/ensure/file.js
var require_file = __commonJS({
  "node_modules/.pnpm/fs-extra@10.1.0/node_modules/fs-extra/lib/ensure/file.js"(exports2, module2) {
    "use strict";
    var u = require_universalify().fromCallback;
    var path2 = require("path");
    var fs = require_graceful_fs();
    var mkdir = require_mkdirs();
    function createFile(file, callback) {
      function makeFile() {
        fs.writeFile(file, "", (err) => {
          if (err) return callback(err);
          callback();
        });
      }
      fs.stat(file, (err, stats) => {
        if (!err && stats.isFile()) return callback();
        const dir = path2.dirname(file);
        fs.stat(dir, (err2, stats2) => {
          if (err2) {
            if (err2.code === "ENOENT") {
              return mkdir.mkdirs(dir, (err3) => {
                if (err3) return callback(err3);
                makeFile();
              });
            }
            return callback(err2);
          }
          if (stats2.isDirectory()) makeFile();
          else {
            fs.readdir(dir, (err3) => {
              if (err3) return callback(err3);
            });
          }
        });
      });
    }
    function createFileSync(file) {
      let stats;
      try {
        stats = fs.statSync(file);
      } catch {
      }
      if (stats && stats.isFile()) return;
      const dir = path2.dirname(file);
      try {
        if (!fs.statSync(dir).isDirectory()) {
          fs.readdirSync(dir);
        }
      } catch (err) {
        if (err && err.code === "ENOENT") mkdir.mkdirsSync(dir);
        else throw err;
      }
      fs.writeFileSync(file, "");
    }
    module2.exports = {
      createFile: u(createFile),
      createFileSync
    };
  }
});

// node_modules/.pnpm/fs-extra@10.1.0/node_modules/fs-extra/lib/ensure/link.js
var require_link = __commonJS({
  "node_modules/.pnpm/fs-extra@10.1.0/node_modules/fs-extra/lib/ensure/link.js"(exports2, module2) {
    "use strict";
    var u = require_universalify().fromCallback;
    var path2 = require("path");
    var fs = require_graceful_fs();
    var mkdir = require_mkdirs();
    var pathExists = require_path_exists().pathExists;
    var { areIdentical } = require_stat();
    function createLink(srcpath, dstpath, callback) {
      function makeLink(srcpath2, dstpath2) {
        fs.link(srcpath2, dstpath2, (err) => {
          if (err) return callback(err);
          callback(null);
        });
      }
      fs.lstat(dstpath, (_, dstStat) => {
        fs.lstat(srcpath, (err, srcStat) => {
          if (err) {
            err.message = err.message.replace("lstat", "ensureLink");
            return callback(err);
          }
          if (dstStat && areIdentical(srcStat, dstStat)) return callback(null);
          const dir = path2.dirname(dstpath);
          pathExists(dir, (err2, dirExists) => {
            if (err2) return callback(err2);
            if (dirExists) return makeLink(srcpath, dstpath);
            mkdir.mkdirs(dir, (err3) => {
              if (err3) return callback(err3);
              makeLink(srcpath, dstpath);
            });
          });
        });
      });
    }
    function createLinkSync(srcpath, dstpath) {
      let dstStat;
      try {
        dstStat = fs.lstatSync(dstpath);
      } catch {
      }
      try {
        const srcStat = fs.lstatSync(srcpath);
        if (dstStat && areIdentical(srcStat, dstStat)) return;
      } catch (err) {
        err.message = err.message.replace("lstat", "ensureLink");
        throw err;
      }
      const dir = path2.dirname(dstpath);
      const dirExists = fs.existsSync(dir);
      if (dirExists) return fs.linkSync(srcpath, dstpath);
      mkdir.mkdirsSync(dir);
      return fs.linkSync(srcpath, dstpath);
    }
    module2.exports = {
      createLink: u(createLink),
      createLinkSync
    };
  }
});

// node_modules/.pnpm/fs-extra@10.1.0/node_modules/fs-extra/lib/ensure/symlink-paths.js
var require_symlink_paths = __commonJS({
  "node_modules/.pnpm/fs-extra@10.1.0/node_modules/fs-extra/lib/ensure/symlink-paths.js"(exports2, module2) {
    "use strict";
    var path2 = require("path");
    var fs = require_graceful_fs();
    var pathExists = require_path_exists().pathExists;
    function symlinkPaths(srcpath, dstpath, callback) {
      if (path2.isAbsolute(srcpath)) {
        return fs.lstat(srcpath, (err) => {
          if (err) {
            err.message = err.message.replace("lstat", "ensureSymlink");
            return callback(err);
          }
          return callback(null, {
            toCwd: srcpath,
            toDst: srcpath
          });
        });
      } else {
        const dstdir = path2.dirname(dstpath);
        const relativeToDst = path2.join(dstdir, srcpath);
        return pathExists(relativeToDst, (err, exists) => {
          if (err) return callback(err);
          if (exists) {
            return callback(null, {
              toCwd: relativeToDst,
              toDst: srcpath
            });
          } else {
            return fs.lstat(srcpath, (err2) => {
              if (err2) {
                err2.message = err2.message.replace("lstat", "ensureSymlink");
                return callback(err2);
              }
              return callback(null, {
                toCwd: srcpath,
                toDst: path2.relative(dstdir, srcpath)
              });
            });
          }
        });
      }
    }
    function symlinkPathsSync(srcpath, dstpath) {
      let exists;
      if (path2.isAbsolute(srcpath)) {
        exists = fs.existsSync(srcpath);
        if (!exists) throw new Error("absolute srcpath does not exist");
        return {
          toCwd: srcpath,
          toDst: srcpath
        };
      } else {
        const dstdir = path2.dirname(dstpath);
        const relativeToDst = path2.join(dstdir, srcpath);
        exists = fs.existsSync(relativeToDst);
        if (exists) {
          return {
            toCwd: relativeToDst,
            toDst: srcpath
          };
        } else {
          exists = fs.existsSync(srcpath);
          if (!exists) throw new Error("relative srcpath does not exist");
          return {
            toCwd: srcpath,
            toDst: path2.relative(dstdir, srcpath)
          };
        }
      }
    }
    module2.exports = {
      symlinkPaths,
      symlinkPathsSync
    };
  }
});

// node_modules/.pnpm/fs-extra@10.1.0/node_modules/fs-extra/lib/ensure/symlink-type.js
var require_symlink_type = __commonJS({
  "node_modules/.pnpm/fs-extra@10.1.0/node_modules/fs-extra/lib/ensure/symlink-type.js"(exports2, module2) {
    "use strict";
    var fs = require_graceful_fs();
    function symlinkType(srcpath, type, callback) {
      callback = typeof type === "function" ? type : callback;
      type = typeof type === "function" ? false : type;
      if (type) return callback(null, type);
      fs.lstat(srcpath, (err, stats) => {
        if (err) return callback(null, "file");
        type = stats && stats.isDirectory() ? "dir" : "file";
        callback(null, type);
      });
    }
    function symlinkTypeSync(srcpath, type) {
      let stats;
      if (type) return type;
      try {
        stats = fs.lstatSync(srcpath);
      } catch {
        return "file";
      }
      return stats && stats.isDirectory() ? "dir" : "file";
    }
    module2.exports = {
      symlinkType,
      symlinkTypeSync
    };
  }
});

// node_modules/.pnpm/fs-extra@10.1.0/node_modules/fs-extra/lib/ensure/symlink.js
var require_symlink = __commonJS({
  "node_modules/.pnpm/fs-extra@10.1.0/node_modules/fs-extra/lib/ensure/symlink.js"(exports2, module2) {
    "use strict";
    var u = require_universalify().fromCallback;
    var path2 = require("path");
    var fs = require_fs();
    var _mkdirs = require_mkdirs();
    var mkdirs = _mkdirs.mkdirs;
    var mkdirsSync = _mkdirs.mkdirsSync;
    var _symlinkPaths = require_symlink_paths();
    var symlinkPaths = _symlinkPaths.symlinkPaths;
    var symlinkPathsSync = _symlinkPaths.symlinkPathsSync;
    var _symlinkType = require_symlink_type();
    var symlinkType = _symlinkType.symlinkType;
    var symlinkTypeSync = _symlinkType.symlinkTypeSync;
    var pathExists = require_path_exists().pathExists;
    var { areIdentical } = require_stat();
    function createSymlink(srcpath, dstpath, type, callback) {
      callback = typeof type === "function" ? type : callback;
      type = typeof type === "function" ? false : type;
      fs.lstat(dstpath, (err, stats) => {
        if (!err && stats.isSymbolicLink()) {
          Promise.all([
            fs.stat(srcpath),
            fs.stat(dstpath)
          ]).then(([srcStat, dstStat]) => {
            if (areIdentical(srcStat, dstStat)) return callback(null);
            _createSymlink(srcpath, dstpath, type, callback);
          });
        } else _createSymlink(srcpath, dstpath, type, callback);
      });
    }
    function _createSymlink(srcpath, dstpath, type, callback) {
      symlinkPaths(srcpath, dstpath, (err, relative) => {
        if (err) return callback(err);
        srcpath = relative.toDst;
        symlinkType(relative.toCwd, type, (err2, type2) => {
          if (err2) return callback(err2);
          const dir = path2.dirname(dstpath);
          pathExists(dir, (err3, dirExists) => {
            if (err3) return callback(err3);
            if (dirExists) return fs.symlink(srcpath, dstpath, type2, callback);
            mkdirs(dir, (err4) => {
              if (err4) return callback(err4);
              fs.symlink(srcpath, dstpath, type2, callback);
            });
          });
        });
      });
    }
    function createSymlinkSync(srcpath, dstpath, type) {
      let stats;
      try {
        stats = fs.lstatSync(dstpath);
      } catch {
      }
      if (stats && stats.isSymbolicLink()) {
        const srcStat = fs.statSync(srcpath);
        const dstStat = fs.statSync(dstpath);
        if (areIdentical(srcStat, dstStat)) return;
      }
      const relative = symlinkPathsSync(srcpath, dstpath);
      srcpath = relative.toDst;
      type = symlinkTypeSync(relative.toCwd, type);
      const dir = path2.dirname(dstpath);
      const exists = fs.existsSync(dir);
      if (exists) return fs.symlinkSync(srcpath, dstpath, type);
      mkdirsSync(dir);
      return fs.symlinkSync(srcpath, dstpath, type);
    }
    module2.exports = {
      createSymlink: u(createSymlink),
      createSymlinkSync
    };
  }
});

// node_modules/.pnpm/fs-extra@10.1.0/node_modules/fs-extra/lib/ensure/index.js
var require_ensure = __commonJS({
  "node_modules/.pnpm/fs-extra@10.1.0/node_modules/fs-extra/lib/ensure/index.js"(exports2, module2) {
    "use strict";
    var { createFile, createFileSync } = require_file();
    var { createLink, createLinkSync } = require_link();
    var { createSymlink, createSymlinkSync } = require_symlink();
    module2.exports = {
      // file
      createFile,
      createFileSync,
      ensureFile: createFile,
      ensureFileSync: createFileSync,
      // link
      createLink,
      createLinkSync,
      ensureLink: createLink,
      ensureLinkSync: createLinkSync,
      // symlink
      createSymlink,
      createSymlinkSync,
      ensureSymlink: createSymlink,
      ensureSymlinkSync: createSymlinkSync
    };
  }
});

// node_modules/.pnpm/jsonfile@6.2.1/node_modules/jsonfile/utils.js
var require_utils2 = __commonJS({
  "node_modules/.pnpm/jsonfile@6.2.1/node_modules/jsonfile/utils.js"(exports2, module2) {
    function stringify(obj, { EOL = "\n", finalEOL = true, replacer = null, spaces } = {}) {
      const EOF = finalEOL ? EOL : "";
      const str = JSON.stringify(obj, replacer, spaces);
      if (str === void 0) {
        throw new TypeError(`Converting ${typeof obj} value to JSON is not supported`);
      }
      return str.replace(/\n/g, EOL) + EOF;
    }
    function stripBom(content) {
      if (Buffer.isBuffer(content)) content = content.toString("utf8");
      return content.replace(/^\uFEFF/, "");
    }
    module2.exports = { stringify, stripBom };
  }
});

// node_modules/.pnpm/jsonfile@6.2.1/node_modules/jsonfile/index.js
var require_jsonfile = __commonJS({
  "node_modules/.pnpm/jsonfile@6.2.1/node_modules/jsonfile/index.js"(exports2, module2) {
    var _fs;
    try {
      _fs = require_graceful_fs();
    } catch (_) {
      _fs = require("fs");
    }
    var universalify = require_universalify();
    var { stringify, stripBom } = require_utils2();
    async function _readFile(file, options = {}) {
      if (typeof options === "string") {
        options = { encoding: options };
      }
      const fs = options.fs || _fs;
      const shouldThrow = "throws" in options ? options.throws : true;
      let data = await universalify.fromCallback(fs.readFile)(file, options);
      data = stripBom(data);
      let obj;
      try {
        obj = JSON.parse(data, options ? options.reviver : null);
      } catch (err) {
        if (shouldThrow) {
          err.message = `${file}: ${err.message}`;
          throw err;
        } else {
          return null;
        }
      }
      return obj;
    }
    var readFile = universalify.fromPromise(_readFile);
    function readFileSync(file, options = {}) {
      if (typeof options === "string") {
        options = { encoding: options };
      }
      const fs = options.fs || _fs;
      const shouldThrow = "throws" in options ? options.throws : true;
      try {
        let content = fs.readFileSync(file, options);
        content = stripBom(content);
        return JSON.parse(content, options.reviver);
      } catch (err) {
        if (shouldThrow) {
          err.message = `${file}: ${err.message}`;
          throw err;
        } else {
          return null;
        }
      }
    }
    async function _writeFile(file, obj, options = {}) {
      const fs = options.fs || _fs;
      const str = stringify(obj, options);
      await universalify.fromCallback(fs.writeFile)(file, str, options);
    }
    var writeFile = universalify.fromPromise(_writeFile);
    function writeFileSync(file, obj, options = {}) {
      const fs = options.fs || _fs;
      const str = stringify(obj, options);
      return fs.writeFileSync(file, str, options);
    }
    module2.exports = {
      readFile,
      readFileSync,
      writeFile,
      writeFileSync
    };
  }
});

// node_modules/.pnpm/fs-extra@10.1.0/node_modules/fs-extra/lib/json/jsonfile.js
var require_jsonfile2 = __commonJS({
  "node_modules/.pnpm/fs-extra@10.1.0/node_modules/fs-extra/lib/json/jsonfile.js"(exports2, module2) {
    "use strict";
    var jsonFile = require_jsonfile();
    module2.exports = {
      // jsonfile exports
      readJson: jsonFile.readFile,
      readJsonSync: jsonFile.readFileSync,
      writeJson: jsonFile.writeFile,
      writeJsonSync: jsonFile.writeFileSync
    };
  }
});

// node_modules/.pnpm/fs-extra@10.1.0/node_modules/fs-extra/lib/output-file/index.js
var require_output_file = __commonJS({
  "node_modules/.pnpm/fs-extra@10.1.0/node_modules/fs-extra/lib/output-file/index.js"(exports2, module2) {
    "use strict";
    var u = require_universalify().fromCallback;
    var fs = require_graceful_fs();
    var path2 = require("path");
    var mkdir = require_mkdirs();
    var pathExists = require_path_exists().pathExists;
    function outputFile(file, data, encoding, callback) {
      if (typeof encoding === "function") {
        callback = encoding;
        encoding = "utf8";
      }
      const dir = path2.dirname(file);
      pathExists(dir, (err, itDoes) => {
        if (err) return callback(err);
        if (itDoes) return fs.writeFile(file, data, encoding, callback);
        mkdir.mkdirs(dir, (err2) => {
          if (err2) return callback(err2);
          fs.writeFile(file, data, encoding, callback);
        });
      });
    }
    function outputFileSync(file, ...args) {
      const dir = path2.dirname(file);
      if (fs.existsSync(dir)) {
        return fs.writeFileSync(file, ...args);
      }
      mkdir.mkdirsSync(dir);
      fs.writeFileSync(file, ...args);
    }
    module2.exports = {
      outputFile: u(outputFile),
      outputFileSync
    };
  }
});

// node_modules/.pnpm/fs-extra@10.1.0/node_modules/fs-extra/lib/json/output-json.js
var require_output_json = __commonJS({
  "node_modules/.pnpm/fs-extra@10.1.0/node_modules/fs-extra/lib/json/output-json.js"(exports2, module2) {
    "use strict";
    var { stringify } = require_utils2();
    var { outputFile } = require_output_file();
    async function outputJson(file, data, options = {}) {
      const str = stringify(data, options);
      await outputFile(file, str, options);
    }
    module2.exports = outputJson;
  }
});

// node_modules/.pnpm/fs-extra@10.1.0/node_modules/fs-extra/lib/json/output-json-sync.js
var require_output_json_sync = __commonJS({
  "node_modules/.pnpm/fs-extra@10.1.0/node_modules/fs-extra/lib/json/output-json-sync.js"(exports2, module2) {
    "use strict";
    var { stringify } = require_utils2();
    var { outputFileSync } = require_output_file();
    function outputJsonSync(file, data, options) {
      const str = stringify(data, options);
      outputFileSync(file, str, options);
    }
    module2.exports = outputJsonSync;
  }
});

// node_modules/.pnpm/fs-extra@10.1.0/node_modules/fs-extra/lib/json/index.js
var require_json = __commonJS({
  "node_modules/.pnpm/fs-extra@10.1.0/node_modules/fs-extra/lib/json/index.js"(exports2, module2) {
    "use strict";
    var u = require_universalify().fromPromise;
    var jsonFile = require_jsonfile2();
    jsonFile.outputJson = u(require_output_json());
    jsonFile.outputJsonSync = require_output_json_sync();
    jsonFile.outputJSON = jsonFile.outputJson;
    jsonFile.outputJSONSync = jsonFile.outputJsonSync;
    jsonFile.writeJSON = jsonFile.writeJson;
    jsonFile.writeJSONSync = jsonFile.writeJsonSync;
    jsonFile.readJSON = jsonFile.readJson;
    jsonFile.readJSONSync = jsonFile.readJsonSync;
    module2.exports = jsonFile;
  }
});

// node_modules/.pnpm/fs-extra@10.1.0/node_modules/fs-extra/lib/move/move.js
var require_move = __commonJS({
  "node_modules/.pnpm/fs-extra@10.1.0/node_modules/fs-extra/lib/move/move.js"(exports2, module2) {
    "use strict";
    var fs = require_graceful_fs();
    var path2 = require("path");
    var copy = require_copy2().copy;
    var remove = require_remove().remove;
    var mkdirp = require_mkdirs().mkdirp;
    var pathExists = require_path_exists().pathExists;
    var stat = require_stat();
    function move(src, dest, opts, cb) {
      if (typeof opts === "function") {
        cb = opts;
        opts = {};
      }
      opts = opts || {};
      const overwrite = opts.overwrite || opts.clobber || false;
      stat.checkPaths(src, dest, "move", opts, (err, stats) => {
        if (err) return cb(err);
        const { srcStat, isChangingCase = false } = stats;
        stat.checkParentPaths(src, srcStat, dest, "move", (err2) => {
          if (err2) return cb(err2);
          if (isParentRoot(dest)) return doRename(src, dest, overwrite, isChangingCase, cb);
          mkdirp(path2.dirname(dest), (err3) => {
            if (err3) return cb(err3);
            return doRename(src, dest, overwrite, isChangingCase, cb);
          });
        });
      });
    }
    function isParentRoot(dest) {
      const parent = path2.dirname(dest);
      const parsedPath = path2.parse(parent);
      return parsedPath.root === parent;
    }
    function doRename(src, dest, overwrite, isChangingCase, cb) {
      if (isChangingCase) return rename(src, dest, overwrite, cb);
      if (overwrite) {
        return remove(dest, (err) => {
          if (err) return cb(err);
          return rename(src, dest, overwrite, cb);
        });
      }
      pathExists(dest, (err, destExists) => {
        if (err) return cb(err);
        if (destExists) return cb(new Error("dest already exists."));
        return rename(src, dest, overwrite, cb);
      });
    }
    function rename(src, dest, overwrite, cb) {
      fs.rename(src, dest, (err) => {
        if (!err) return cb();
        if (err.code !== "EXDEV") return cb(err);
        return moveAcrossDevice(src, dest, overwrite, cb);
      });
    }
    function moveAcrossDevice(src, dest, overwrite, cb) {
      const opts = {
        overwrite,
        errorOnExist: true
      };
      copy(src, dest, opts, (err) => {
        if (err) return cb(err);
        return remove(src, cb);
      });
    }
    module2.exports = move;
  }
});

// node_modules/.pnpm/fs-extra@10.1.0/node_modules/fs-extra/lib/move/move-sync.js
var require_move_sync = __commonJS({
  "node_modules/.pnpm/fs-extra@10.1.0/node_modules/fs-extra/lib/move/move-sync.js"(exports2, module2) {
    "use strict";
    var fs = require_graceful_fs();
    var path2 = require("path");
    var copySync = require_copy2().copySync;
    var removeSync = require_remove().removeSync;
    var mkdirpSync = require_mkdirs().mkdirpSync;
    var stat = require_stat();
    function moveSync(src, dest, opts) {
      opts = opts || {};
      const overwrite = opts.overwrite || opts.clobber || false;
      const { srcStat, isChangingCase = false } = stat.checkPathsSync(src, dest, "move", opts);
      stat.checkParentPathsSync(src, srcStat, dest, "move");
      if (!isParentRoot(dest)) mkdirpSync(path2.dirname(dest));
      return doRename(src, dest, overwrite, isChangingCase);
    }
    function isParentRoot(dest) {
      const parent = path2.dirname(dest);
      const parsedPath = path2.parse(parent);
      return parsedPath.root === parent;
    }
    function doRename(src, dest, overwrite, isChangingCase) {
      if (isChangingCase) return rename(src, dest, overwrite);
      if (overwrite) {
        removeSync(dest);
        return rename(src, dest, overwrite);
      }
      if (fs.existsSync(dest)) throw new Error("dest already exists.");
      return rename(src, dest, overwrite);
    }
    function rename(src, dest, overwrite) {
      try {
        fs.renameSync(src, dest);
      } catch (err) {
        if (err.code !== "EXDEV") throw err;
        return moveAcrossDevice(src, dest, overwrite);
      }
    }
    function moveAcrossDevice(src, dest, overwrite) {
      const opts = {
        overwrite,
        errorOnExist: true
      };
      copySync(src, dest, opts);
      return removeSync(src);
    }
    module2.exports = moveSync;
  }
});

// node_modules/.pnpm/fs-extra@10.1.0/node_modules/fs-extra/lib/move/index.js
var require_move2 = __commonJS({
  "node_modules/.pnpm/fs-extra@10.1.0/node_modules/fs-extra/lib/move/index.js"(exports2, module2) {
    "use strict";
    var u = require_universalify().fromCallback;
    module2.exports = {
      move: u(require_move()),
      moveSync: require_move_sync()
    };
  }
});

// node_modules/.pnpm/fs-extra@10.1.0/node_modules/fs-extra/lib/index.js
var require_lib = __commonJS({
  "node_modules/.pnpm/fs-extra@10.1.0/node_modules/fs-extra/lib/index.js"(exports2, module2) {
    "use strict";
    module2.exports = {
      // Export promiseified graceful-fs:
      ...require_fs(),
      // Export extra methods:
      ...require_copy2(),
      ...require_empty(),
      ...require_ensure(),
      ...require_json(),
      ...require_mkdirs(),
      ...require_move2(),
      ...require_output_file(),
      ...require_path_exists(),
      ...require_remove()
    };
  }
});

// node_modules/.pnpm/builder-util-runtime@9.7.0/node_modules/builder-util-runtime/out/CancellationToken.js
var require_CancellationToken = __commonJS({
  "node_modules/.pnpm/builder-util-runtime@9.7.0/node_modules/builder-util-runtime/out/CancellationToken.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.CancellationError = exports2.CancellationToken = void 0;
    var events_1 = require("events");
    var CancellationToken = class extends events_1.EventEmitter {
      get cancelled() {
        return this._cancelled || this._parent != null && this._parent.cancelled;
      }
      set parent(value) {
        this.removeParentCancelHandler();
        this._parent = value;
        this.parentCancelHandler = () => this.cancel();
        this._parent.onCancel(this.parentCancelHandler);
      }
      // babel cannot compile ... correctly for super calls
      constructor(parent) {
        super();
        this.parentCancelHandler = null;
        this._parent = null;
        this._cancelled = false;
        if (parent != null) {
          this.parent = parent;
        }
      }
      cancel() {
        this._cancelled = true;
        this.emit("cancel");
      }
      onCancel(handler) {
        if (this.cancelled) {
          handler();
        } else {
          this.once("cancel", handler);
        }
      }
      createPromise(callback) {
        if (this.cancelled) {
          return Promise.reject(new CancellationError());
        }
        const finallyHandler = () => {
          if (cancelHandler != null) {
            try {
              this.removeListener("cancel", cancelHandler);
              cancelHandler = null;
            } catch (_ignore) {
            }
          }
        };
        let cancelHandler = null;
        return new Promise((resolve, reject) => {
          let addedCancelHandler = null;
          cancelHandler = () => {
            try {
              if (addedCancelHandler != null) {
                addedCancelHandler();
                addedCancelHandler = null;
              }
            } finally {
              reject(new CancellationError());
            }
          };
          if (this.cancelled) {
            cancelHandler();
            return;
          }
          this.onCancel(cancelHandler);
          callback(resolve, reject, (callback2) => {
            addedCancelHandler = callback2;
          });
        }).then((it) => {
          finallyHandler();
          return it;
        }).catch((e) => {
          finallyHandler();
          throw e;
        });
      }
      removeParentCancelHandler() {
        const parent = this._parent;
        if (parent != null && this.parentCancelHandler != null) {
          parent.removeListener("cancel", this.parentCancelHandler);
          this.parentCancelHandler = null;
        }
      }
      dispose() {
        try {
          this.removeParentCancelHandler();
        } finally {
          this.removeAllListeners();
          this._parent = null;
        }
      }
    };
    exports2.CancellationToken = CancellationToken;
    var CancellationError = class extends Error {
      constructor() {
        super("cancelled");
      }
    };
    exports2.CancellationError = CancellationError;
  }
});

// node_modules/.pnpm/builder-util-runtime@9.7.0/node_modules/builder-util-runtime/out/error.js
var require_error = __commonJS({
  "node_modules/.pnpm/builder-util-runtime@9.7.0/node_modules/builder-util-runtime/out/error.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.newError = newError;
    function newError(message, code) {
      const error = new Error(message);
      error.code = code;
      return error;
    }
  }
});

// node_modules/.pnpm/ms@2.1.3/node_modules/ms/index.js
var require_ms = __commonJS({
  "node_modules/.pnpm/ms@2.1.3/node_modules/ms/index.js"(exports2, module2) {
    var s = 1e3;
    var m = s * 60;
    var h = m * 60;
    var d = h * 24;
    var w = d * 7;
    var y = d * 365.25;
    module2.exports = function(val, options) {
      options = options || {};
      var type = typeof val;
      if (type === "string" && val.length > 0) {
        return parse(val);
      } else if (type === "number" && isFinite(val)) {
        return options.long ? fmtLong(val) : fmtShort(val);
      }
      throw new Error(
        "val is not a non-empty string or a valid number. val=" + JSON.stringify(val)
      );
    };
    function parse(str) {
      str = String(str);
      if (str.length > 100) {
        return;
      }
      var match = /^(-?(?:\d+)?\.?\d+) *(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w|years?|yrs?|y)?$/i.exec(
        str
      );
      if (!match) {
        return;
      }
      var n = parseFloat(match[1]);
      var type = (match[2] || "ms").toLowerCase();
      switch (type) {
        case "years":
        case "year":
        case "yrs":
        case "yr":
        case "y":
          return n * y;
        case "weeks":
        case "week":
        case "w":
          return n * w;
        case "days":
        case "day":
        case "d":
          return n * d;
        case "hours":
        case "hour":
        case "hrs":
        case "hr":
        case "h":
          return n * h;
        case "minutes":
        case "minute":
        case "mins":
        case "min":
        case "m":
          return n * m;
        case "seconds":
        case "second":
        case "secs":
        case "sec":
        case "s":
          return n * s;
        case "milliseconds":
        case "millisecond":
        case "msecs":
        case "msec":
        case "ms":
          return n;
        default:
          return void 0;
      }
    }
    function fmtShort(ms) {
      var msAbs = Math.abs(ms);
      if (msAbs >= d) {
        return Math.round(ms / d) + "d";
      }
      if (msAbs >= h) {
        return Math.round(ms / h) + "h";
      }
      if (msAbs >= m) {
        return Math.round(ms / m) + "m";
      }
      if (msAbs >= s) {
        return Math.round(ms / s) + "s";
      }
      return ms + "ms";
    }
    function fmtLong(ms) {
      var msAbs = Math.abs(ms);
      if (msAbs >= d) {
        return plural(ms, msAbs, d, "day");
      }
      if (msAbs >= h) {
        return plural(ms, msAbs, h, "hour");
      }
      if (msAbs >= m) {
        return plural(ms, msAbs, m, "minute");
      }
      if (msAbs >= s) {
        return plural(ms, msAbs, s, "second");
      }
      return ms + " ms";
    }
    function plural(ms, msAbs, n, name) {
      var isPlural = msAbs >= n * 1.5;
      return Math.round(ms / n) + " " + name + (isPlural ? "s" : "");
    }
  }
});

// node_modules/.pnpm/debug@4.4.3/node_modules/debug/src/common.js
var require_common = __commonJS({
  "node_modules/.pnpm/debug@4.4.3/node_modules/debug/src/common.js"(exports2, module2) {
    function setup(env) {
      createDebug.debug = createDebug;
      createDebug.default = createDebug;
      createDebug.coerce = coerce;
      createDebug.disable = disable;
      createDebug.enable = enable;
      createDebug.enabled = enabled;
      createDebug.humanize = require_ms();
      createDebug.destroy = destroy;
      Object.keys(env).forEach((key) => {
        createDebug[key] = env[key];
      });
      createDebug.names = [];
      createDebug.skips = [];
      createDebug.formatters = {};
      function selectColor(namespace) {
        let hash = 0;
        for (let i = 0; i < namespace.length; i++) {
          hash = (hash << 5) - hash + namespace.charCodeAt(i);
          hash |= 0;
        }
        return createDebug.colors[Math.abs(hash) % createDebug.colors.length];
      }
      createDebug.selectColor = selectColor;
      function createDebug(namespace) {
        let prevTime;
        let enableOverride = null;
        let namespacesCache;
        let enabledCache;
        function debug(...args) {
          if (!debug.enabled) {
            return;
          }
          const self2 = debug;
          const curr = Number(/* @__PURE__ */ new Date());
          const ms = curr - (prevTime || curr);
          self2.diff = ms;
          self2.prev = prevTime;
          self2.curr = curr;
          prevTime = curr;
          args[0] = createDebug.coerce(args[0]);
          if (typeof args[0] !== "string") {
            args.unshift("%O");
          }
          let index = 0;
          args[0] = args[0].replace(/%([a-zA-Z%])/g, (match, format) => {
            if (match === "%%") {
              return "%";
            }
            index++;
            const formatter = createDebug.formatters[format];
            if (typeof formatter === "function") {
              const val = args[index];
              match = formatter.call(self2, val);
              args.splice(index, 1);
              index--;
            }
            return match;
          });
          createDebug.formatArgs.call(self2, args);
          const logFn = self2.log || createDebug.log;
          logFn.apply(self2, args);
        }
        debug.namespace = namespace;
        debug.useColors = createDebug.useColors();
        debug.color = createDebug.selectColor(namespace);
        debug.extend = extend;
        debug.destroy = createDebug.destroy;
        Object.defineProperty(debug, "enabled", {
          enumerable: true,
          configurable: false,
          get: () => {
            if (enableOverride !== null) {
              return enableOverride;
            }
            if (namespacesCache !== createDebug.namespaces) {
              namespacesCache = createDebug.namespaces;
              enabledCache = createDebug.enabled(namespace);
            }
            return enabledCache;
          },
          set: (v) => {
            enableOverride = v;
          }
        });
        if (typeof createDebug.init === "function") {
          createDebug.init(debug);
        }
        return debug;
      }
      function extend(namespace, delimiter) {
        const newDebug = createDebug(this.namespace + (typeof delimiter === "undefined" ? ":" : delimiter) + namespace);
        newDebug.log = this.log;
        return newDebug;
      }
      function enable(namespaces) {
        createDebug.save(namespaces);
        createDebug.namespaces = namespaces;
        createDebug.names = [];
        createDebug.skips = [];
        const split = (typeof namespaces === "string" ? namespaces : "").trim().replace(/\s+/g, ",").split(",").filter(Boolean);
        for (const ns of split) {
          if (ns[0] === "-") {
            createDebug.skips.push(ns.slice(1));
          } else {
            createDebug.names.push(ns);
          }
        }
      }
      function matchesTemplate(search, template) {
        let searchIndex = 0;
        let templateIndex = 0;
        let starIndex = -1;
        let matchIndex = 0;
        while (searchIndex < search.length) {
          if (templateIndex < template.length && (template[templateIndex] === search[searchIndex] || template[templateIndex] === "*")) {
            if (template[templateIndex] === "*") {
              starIndex = templateIndex;
              matchIndex = searchIndex;
              templateIndex++;
            } else {
              searchIndex++;
              templateIndex++;
            }
          } else if (starIndex !== -1) {
            templateIndex = starIndex + 1;
            matchIndex++;
            searchIndex = matchIndex;
          } else {
            return false;
          }
        }
        while (templateIndex < template.length && template[templateIndex] === "*") {
          templateIndex++;
        }
        return templateIndex === template.length;
      }
      function disable() {
        const namespaces = [
          ...createDebug.names,
          ...createDebug.skips.map((namespace) => "-" + namespace)
        ].join(",");
        createDebug.enable("");
        return namespaces;
      }
      function enabled(name) {
        for (const skip of createDebug.skips) {
          if (matchesTemplate(name, skip)) {
            return false;
          }
        }
        for (const ns of createDebug.names) {
          if (matchesTemplate(name, ns)) {
            return true;
          }
        }
        return false;
      }
      function coerce(val) {
        if (val instanceof Error) {
          return val.stack || val.message;
        }
        return val;
      }
      function destroy() {
        console.warn("Instance method `debug.destroy()` is deprecated and no longer does anything. It will be removed in the next major version of `debug`.");
      }
      createDebug.enable(createDebug.load());
      return createDebug;
    }
    module2.exports = setup;
  }
});

// node_modules/.pnpm/debug@4.4.3/node_modules/debug/src/browser.js
var require_browser = __commonJS({
  "node_modules/.pnpm/debug@4.4.3/node_modules/debug/src/browser.js"(exports2, module2) {
    exports2.formatArgs = formatArgs;
    exports2.save = save;
    exports2.load = load;
    exports2.useColors = useColors;
    exports2.storage = localstorage();
    exports2.destroy = /* @__PURE__ */ (() => {
      let warned = false;
      return () => {
        if (!warned) {
          warned = true;
          console.warn("Instance method `debug.destroy()` is deprecated and no longer does anything. It will be removed in the next major version of `debug`.");
        }
      };
    })();
    exports2.colors = [
      "#0000CC",
      "#0000FF",
      "#0033CC",
      "#0033FF",
      "#0066CC",
      "#0066FF",
      "#0099CC",
      "#0099FF",
      "#00CC00",
      "#00CC33",
      "#00CC66",
      "#00CC99",
      "#00CCCC",
      "#00CCFF",
      "#3300CC",
      "#3300FF",
      "#3333CC",
      "#3333FF",
      "#3366CC",
      "#3366FF",
      "#3399CC",
      "#3399FF",
      "#33CC00",
      "#33CC33",
      "#33CC66",
      "#33CC99",
      "#33CCCC",
      "#33CCFF",
      "#6600CC",
      "#6600FF",
      "#6633CC",
      "#6633FF",
      "#66CC00",
      "#66CC33",
      "#9900CC",
      "#9900FF",
      "#9933CC",
      "#9933FF",
      "#99CC00",
      "#99CC33",
      "#CC0000",
      "#CC0033",
      "#CC0066",
      "#CC0099",
      "#CC00CC",
      "#CC00FF",
      "#CC3300",
      "#CC3333",
      "#CC3366",
      "#CC3399",
      "#CC33CC",
      "#CC33FF",
      "#CC6600",
      "#CC6633",
      "#CC9900",
      "#CC9933",
      "#CCCC00",
      "#CCCC33",
      "#FF0000",
      "#FF0033",
      "#FF0066",
      "#FF0099",
      "#FF00CC",
      "#FF00FF",
      "#FF3300",
      "#FF3333",
      "#FF3366",
      "#FF3399",
      "#FF33CC",
      "#FF33FF",
      "#FF6600",
      "#FF6633",
      "#FF9900",
      "#FF9933",
      "#FFCC00",
      "#FFCC33"
    ];
    function useColors() {
      if (typeof window !== "undefined" && window.process && (window.process.type === "renderer" || window.process.__nwjs)) {
        return true;
      }
      if (typeof navigator !== "undefined" && navigator.userAgent && navigator.userAgent.toLowerCase().match(/(edge|trident)\/(\d+)/)) {
        return false;
      }
      let m;
      return typeof document !== "undefined" && document.documentElement && document.documentElement.style && document.documentElement.style.WebkitAppearance || // Is firebug? http://stackoverflow.com/a/398120/376773
      typeof window !== "undefined" && window.console && (window.console.firebug || window.console.exception && window.console.table) || // Is firefox >= v31?
      // https://developer.mozilla.org/en-US/docs/Tools/Web_Console#Styling_messages
      typeof navigator !== "undefined" && navigator.userAgent && (m = navigator.userAgent.toLowerCase().match(/firefox\/(\d+)/)) && parseInt(m[1], 10) >= 31 || // Double check webkit in userAgent just in case we are in a worker
      typeof navigator !== "undefined" && navigator.userAgent && navigator.userAgent.toLowerCase().match(/applewebkit\/(\d+)/);
    }
    function formatArgs(args) {
      args[0] = (this.useColors ? "%c" : "") + this.namespace + (this.useColors ? " %c" : " ") + args[0] + (this.useColors ? "%c " : " ") + "+" + module2.exports.humanize(this.diff);
      if (!this.useColors) {
        return;
      }
      const c = "color: " + this.color;
      args.splice(1, 0, c, "color: inherit");
      let index = 0;
      let lastC = 0;
      args[0].replace(/%[a-zA-Z%]/g, (match) => {
        if (match === "%%") {
          return;
        }
        index++;
        if (match === "%c") {
          lastC = index;
        }
      });
      args.splice(lastC, 0, c);
    }
    exports2.log = console.debug || console.log || (() => {
    });
    function save(namespaces) {
      try {
        if (namespaces) {
          exports2.storage.setItem("debug", namespaces);
        } else {
          exports2.storage.removeItem("debug");
        }
      } catch (error) {
      }
    }
    function load() {
      let r;
      try {
        r = exports2.storage.getItem("debug") || exports2.storage.getItem("DEBUG");
      } catch (error) {
      }
      if (!r && typeof process !== "undefined" && "env" in process) {
        r = process.env.DEBUG;
      }
      return r;
    }
    function localstorage() {
      try {
        return localStorage;
      } catch (error) {
      }
    }
    module2.exports = require_common()(exports2);
    var { formatters } = module2.exports;
    formatters.j = function(v) {
      try {
        return JSON.stringify(v);
      } catch (error) {
        return "[UnexpectedJSONParseError]: " + error.message;
      }
    };
  }
});

// node_modules/.pnpm/has-flag@4.0.0/node_modules/has-flag/index.js
var require_has_flag = __commonJS({
  "node_modules/.pnpm/has-flag@4.0.0/node_modules/has-flag/index.js"(exports2, module2) {
    "use strict";
    module2.exports = (flag, argv = process.argv) => {
      const prefix = flag.startsWith("-") ? "" : flag.length === 1 ? "-" : "--";
      const position = argv.indexOf(prefix + flag);
      const terminatorPosition = argv.indexOf("--");
      return position !== -1 && (terminatorPosition === -1 || position < terminatorPosition);
    };
  }
});

// node_modules/.pnpm/supports-color@7.2.0/node_modules/supports-color/index.js
var require_supports_color = __commonJS({
  "node_modules/.pnpm/supports-color@7.2.0/node_modules/supports-color/index.js"(exports2, module2) {
    "use strict";
    var os = require("os");
    var tty = require("tty");
    var hasFlag = require_has_flag();
    var { env } = process;
    var forceColor;
    if (hasFlag("no-color") || hasFlag("no-colors") || hasFlag("color=false") || hasFlag("color=never")) {
      forceColor = 0;
    } else if (hasFlag("color") || hasFlag("colors") || hasFlag("color=true") || hasFlag("color=always")) {
      forceColor = 1;
    }
    if ("FORCE_COLOR" in env) {
      if (env.FORCE_COLOR === "true") {
        forceColor = 1;
      } else if (env.FORCE_COLOR === "false") {
        forceColor = 0;
      } else {
        forceColor = env.FORCE_COLOR.length === 0 ? 1 : Math.min(parseInt(env.FORCE_COLOR, 10), 3);
      }
    }
    function translateLevel(level) {
      if (level === 0) {
        return false;
      }
      return {
        level,
        hasBasic: true,
        has256: level >= 2,
        has16m: level >= 3
      };
    }
    function supportsColor(haveStream, streamIsTTY) {
      if (forceColor === 0) {
        return 0;
      }
      if (hasFlag("color=16m") || hasFlag("color=full") || hasFlag("color=truecolor")) {
        return 3;
      }
      if (hasFlag("color=256")) {
        return 2;
      }
      if (haveStream && !streamIsTTY && forceColor === void 0) {
        return 0;
      }
      const min = forceColor || 0;
      if (env.TERM === "dumb") {
        return min;
      }
      if (process.platform === "win32") {
        const osRelease = os.release().split(".");
        if (Number(osRelease[0]) >= 10 && Number(osRelease[2]) >= 10586) {
          return Number(osRelease[2]) >= 14931 ? 3 : 2;
        }
        return 1;
      }
      if ("CI" in env) {
        if (["TRAVIS", "CIRCLECI", "APPVEYOR", "GITLAB_CI", "GITHUB_ACTIONS", "BUILDKITE"].some((sign) => sign in env) || env.CI_NAME === "codeship") {
          return 1;
        }
        return min;
      }
      if ("TEAMCITY_VERSION" in env) {
        return /^(9\.(0*[1-9]\d*)\.|\d{2,}\.)/.test(env.TEAMCITY_VERSION) ? 1 : 0;
      }
      if (env.COLORTERM === "truecolor") {
        return 3;
      }
      if ("TERM_PROGRAM" in env) {
        const version = parseInt((env.TERM_PROGRAM_VERSION || "").split(".")[0], 10);
        switch (env.TERM_PROGRAM) {
          case "iTerm.app":
            return version >= 3 ? 3 : 2;
          case "Apple_Terminal":
            return 2;
        }
      }
      if (/-256(color)?$/i.test(env.TERM)) {
        return 2;
      }
      if (/^screen|^xterm|^vt100|^vt220|^rxvt|color|ansi|cygwin|linux/i.test(env.TERM)) {
        return 1;
      }
      if ("COLORTERM" in env) {
        return 1;
      }
      return min;
    }
    function getSupportLevel(stream) {
      const level = supportsColor(stream, stream && stream.isTTY);
      return translateLevel(level);
    }
    module2.exports = {
      supportsColor: getSupportLevel,
      stdout: translateLevel(supportsColor(true, tty.isatty(1))),
      stderr: translateLevel(supportsColor(true, tty.isatty(2)))
    };
  }
});

// node_modules/.pnpm/debug@4.4.3/node_modules/debug/src/node.js
var require_node = __commonJS({
  "node_modules/.pnpm/debug@4.4.3/node_modules/debug/src/node.js"(exports2, module2) {
    var tty = require("tty");
    var util = require("util");
    exports2.init = init;
    exports2.log = log;
    exports2.formatArgs = formatArgs;
    exports2.save = save;
    exports2.load = load;
    exports2.useColors = useColors;
    exports2.destroy = util.deprecate(
      () => {
      },
      "Instance method `debug.destroy()` is deprecated and no longer does anything. It will be removed in the next major version of `debug`."
    );
    exports2.colors = [6, 2, 3, 4, 5, 1];
    try {
      const supportsColor = require_supports_color();
      if (supportsColor && (supportsColor.stderr || supportsColor).level >= 2) {
        exports2.colors = [
          20,
          21,
          26,
          27,
          32,
          33,
          38,
          39,
          40,
          41,
          42,
          43,
          44,
          45,
          56,
          57,
          62,
          63,
          68,
          69,
          74,
          75,
          76,
          77,
          78,
          79,
          80,
          81,
          92,
          93,
          98,
          99,
          112,
          113,
          128,
          129,
          134,
          135,
          148,
          149,
          160,
          161,
          162,
          163,
          164,
          165,
          166,
          167,
          168,
          169,
          170,
          171,
          172,
          173,
          178,
          179,
          184,
          185,
          196,
          197,
          198,
          199,
          200,
          201,
          202,
          203,
          204,
          205,
          206,
          207,
          208,
          209,
          214,
          215,
          220,
          221
        ];
      }
    } catch (error) {
    }
    exports2.inspectOpts = Object.keys(process.env).filter((key) => {
      return /^debug_/i.test(key);
    }).reduce((obj, key) => {
      const prop = key.substring(6).toLowerCase().replace(/_([a-z])/g, (_, k) => {
        return k.toUpperCase();
      });
      let val = process.env[key];
      if (/^(yes|on|true|enabled)$/i.test(val)) {
        val = true;
      } else if (/^(no|off|false|disabled)$/i.test(val)) {
        val = false;
      } else if (val === "null") {
        val = null;
      } else {
        val = Number(val);
      }
      obj[prop] = val;
      return obj;
    }, {});
    function useColors() {
      return "colors" in exports2.inspectOpts ? Boolean(exports2.inspectOpts.colors) : tty.isatty(process.stderr.fd);
    }
    function formatArgs(args) {
      const { namespace: name, useColors: useColors2 } = this;
      if (useColors2) {
        const c = this.color;
        const colorCode = "\x1B[3" + (c < 8 ? c : "8;5;" + c);
        const prefix = `  ${colorCode};1m${name} \x1B[0m`;
        args[0] = prefix + args[0].split("\n").join("\n" + prefix);
        args.push(colorCode + "m+" + module2.exports.humanize(this.diff) + "\x1B[0m");
      } else {
        args[0] = getDate() + name + " " + args[0];
      }
    }
    function getDate() {
      if (exports2.inspectOpts.hideDate) {
        return "";
      }
      return (/* @__PURE__ */ new Date()).toISOString() + " ";
    }
    function log(...args) {
      return process.stderr.write(util.formatWithOptions(exports2.inspectOpts, ...args) + "\n");
    }
    function save(namespaces) {
      if (namespaces) {
        process.env.DEBUG = namespaces;
      } else {
        delete process.env.DEBUG;
      }
    }
    function load() {
      return process.env.DEBUG;
    }
    function init(debug) {
      debug.inspectOpts = {};
      const keys = Object.keys(exports2.inspectOpts);
      for (let i = 0; i < keys.length; i++) {
        debug.inspectOpts[keys[i]] = exports2.inspectOpts[keys[i]];
      }
    }
    module2.exports = require_common()(exports2);
    var { formatters } = module2.exports;
    formatters.o = function(v) {
      this.inspectOpts.colors = this.useColors;
      return util.inspect(v, this.inspectOpts).split("\n").map((str) => str.trim()).join(" ");
    };
    formatters.O = function(v) {
      this.inspectOpts.colors = this.useColors;
      return util.inspect(v, this.inspectOpts);
    };
  }
});

// node_modules/.pnpm/debug@4.4.3/node_modules/debug/src/index.js
var require_src = __commonJS({
  "node_modules/.pnpm/debug@4.4.3/node_modules/debug/src/index.js"(exports2, module2) {
    if (typeof process === "undefined" || process.type === "renderer" || process.browser === true || process.__nwjs) {
      module2.exports = require_browser();
    } else {
      module2.exports = require_node();
    }
  }
});

// node_modules/.pnpm/builder-util-runtime@9.7.0/node_modules/builder-util-runtime/out/ProgressCallbackTransform.js
var require_ProgressCallbackTransform = __commonJS({
  "node_modules/.pnpm/builder-util-runtime@9.7.0/node_modules/builder-util-runtime/out/ProgressCallbackTransform.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.ProgressCallbackTransform = void 0;
    var stream_1 = require("stream");
    var ProgressCallbackTransform = class extends stream_1.Transform {
      constructor(total, cancellationToken, onProgress) {
        super();
        this.total = total;
        this.cancellationToken = cancellationToken;
        this.onProgress = onProgress;
        this.start = Date.now();
        this.transferred = 0;
        this.delta = 0;
        this.nextUpdate = this.start + 1e3;
      }
      _transform(chunk, encoding, callback) {
        if (this.cancellationToken.cancelled) {
          callback(new Error("cancelled"), null);
          return;
        }
        this.transferred += chunk.length;
        this.delta += chunk.length;
        const now = Date.now();
        if (now >= this.nextUpdate && this.transferred !== this.total) {
          this.nextUpdate = now + 1e3;
          this.onProgress({
            total: this.total,
            delta: this.delta,
            transferred: this.transferred,
            percent: this.transferred / this.total * 100,
            bytesPerSecond: Math.round(this.transferred / ((now - this.start) / 1e3))
          });
          this.delta = 0;
        }
        callback(null, chunk);
      }
      _flush(callback) {
        if (this.cancellationToken.cancelled) {
          callback(new Error("cancelled"));
          return;
        }
        this.onProgress({
          total: this.total,
          delta: this.delta,
          transferred: this.total,
          percent: 100,
          bytesPerSecond: Math.round(this.transferred / ((Date.now() - this.start) / 1e3))
        });
        this.delta = 0;
        callback(null);
      }
    };
    exports2.ProgressCallbackTransform = ProgressCallbackTransform;
  }
});

// node_modules/.pnpm/builder-util-runtime@9.7.0/node_modules/builder-util-runtime/out/httpExecutor.js
var require_httpExecutor = __commonJS({
  "node_modules/.pnpm/builder-util-runtime@9.7.0/node_modules/builder-util-runtime/out/httpExecutor.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.DigestTransform = exports2.HttpExecutor = exports2.HttpError = void 0;
    exports2.addSensitiveRedirectHeader = addSensitiveRedirectHeader;
    exports2.addSensitiveFieldPattern = addSensitiveFieldPattern;
    exports2.createHttpError = createHttpError;
    exports2.parseJson = parseJson;
    exports2.configureRequestOptionsFromUrl = configureRequestOptionsFromUrl;
    exports2.configureRequestUrl = configureRequestUrl;
    exports2.safeGetHeader = safeGetHeader;
    exports2.configureRequestOptions = configureRequestOptions;
    exports2.isSensitiveFieldName = isSensitiveFieldName;
    exports2.hashSensitiveValue = hashSensitiveValue;
    exports2.safeStringifyJson = safeStringifyJson;
    var crypto_1 = require("crypto");
    var debug_1 = require_src();
    var fs_1 = require("fs");
    var stream_1 = require("stream");
    var url_1 = require("url");
    var CancellationToken_1 = require_CancellationToken();
    var error_1 = require_error();
    var ProgressCallbackTransform_1 = require_ProgressCallbackTransform();
    var debug = (0, debug_1.default)("electron-builder");
    var normalizeName = (name) => name.toLowerCase().replace(/[-_]/g, "");
    var SENSITIVE_REDIRECT_HEADERS = /* @__PURE__ */ new Set(["authorization", "proxyauthorization", "privatetoken", "xapikey", "xauthtoken", "xaccesstoken", "xgitlabtoken", "cookie", "xcsrftoken"]);
    var SENSITIVE_FIELD_PATTERNS = ["token", "password", "secret", "authorization", "credential", "apikey", "passphrase", "auth"];
    var SENSITIVE_FIELD_SUFFIXES = ["key"];
    function addSensitiveRedirectHeader(header) {
      SENSITIVE_REDIRECT_HEADERS.add(normalizeName(header));
    }
    function addSensitiveFieldPattern(pattern) {
      SENSITIVE_FIELD_PATTERNS.push(pattern.toLowerCase().replace(/[-_]/g, ""));
    }
    function createHttpError(response, description = null) {
      return new HttpError(response.statusCode || -1, `${response.statusCode} ${response.statusMessage}` + (description == null ? "" : "\n" + JSON.stringify(description, null, "  ")) + "\nHeaders: " + safeStringifyJson(response.headers), description);
    }
    var HTTP_STATUS_CODES = /* @__PURE__ */ new Map([
      [429, "Too many requests"],
      [400, "Bad request"],
      [403, "Forbidden"],
      [404, "Not found"],
      [405, "Method not allowed"],
      [406, "Not acceptable"],
      [408, "Request timeout"],
      [413, "Request entity too large"],
      [500, "Internal server error"],
      [502, "Bad gateway"],
      [503, "Service unavailable"],
      [504, "Gateway timeout"],
      [505, "HTTP version not supported"]
    ]);
    var HttpError = class extends Error {
      constructor(statusCode, message = `HTTP error: ${HTTP_STATUS_CODES.get(statusCode) || statusCode}`, description = null) {
        super(message);
        this.statusCode = statusCode;
        this.description = description;
        this.name = "HttpError";
        this.code = `HTTP_ERROR_${statusCode}`;
      }
      isServerError() {
        return this.statusCode >= 500 && this.statusCode <= 599;
      }
    };
    exports2.HttpError = HttpError;
    function parseJson(result) {
      return result.then((it) => it == null || it.length === 0 ? null : JSON.parse(it));
    }
    var HttpExecutor = class _HttpExecutor {
      constructor() {
        this.maxRedirects = 10;
      }
      request(options, cancellationToken = new CancellationToken_1.CancellationToken(), data) {
        configureRequestOptions(options);
        const json = data == null ? void 0 : JSON.stringify(data);
        const encodedData = json ? Buffer.from(json) : void 0;
        if (encodedData != null) {
          if (debug.enabled) {
            debug(safeStringifyJson(data));
          }
          const { headers, ...opts } = options;
          options = {
            method: "post",
            headers: {
              "Content-Type": "application/json",
              "Content-Length": encodedData.length,
              ...headers
            },
            ...opts
          };
        }
        return this.doApiRequest(options, cancellationToken, (it) => it.end(encodedData));
      }
      doApiRequest(options, cancellationToken, requestProcessor, redirectCount = 0) {
        if (debug.enabled) {
          const { headers: _headers, auth: _auth, ...safeOptions } = options;
          debug(`Request: ${safeStringifyJson(safeOptions)}`);
        }
        return cancellationToken.createPromise((resolve, reject, onCancel) => {
          const request = this.createRequest(options, (response) => {
            try {
              this.handleResponse(response, options, cancellationToken, resolve, reject, redirectCount, requestProcessor);
            } catch (e) {
              reject(e);
            }
          });
          this.addErrorAndTimeoutHandlers(request, reject, options.timeout);
          this.addRedirectHandlers(request, options, reject, redirectCount, (options2) => {
            this.doApiRequest(options2, cancellationToken, requestProcessor, redirectCount).then(resolve).catch(reject);
          });
          requestProcessor(request, reject);
          onCancel(() => request.abort());
        });
      }
      // noinspection JSUnusedLocalSymbols
      // eslint-disable-next-line
      addRedirectHandlers(request, options, reject, redirectCount, handler) {
      }
      addErrorAndTimeoutHandlers(request, reject, timeout = 60 * 1e3) {
        this.addTimeOutHandler(request, reject, timeout);
        request.on("error", reject);
        request.on("aborted", () => {
          reject(new Error("Request has been aborted by the server"));
        });
      }
      handleResponse(response, options, cancellationToken, resolve, reject, redirectCount, requestProcessor) {
        var _a;
        if (debug.enabled) {
          const { headers: _headers, auth: _auth, ...safeOptions } = options;
          debug(`Response: ${response.statusCode} ${response.statusMessage}, request options: ${safeStringifyJson(safeOptions)}`);
        }
        if (response.statusCode === 404) {
          reject(createHttpError(response, `method: ${options.method || "GET"} url: ${options.protocol || "https:"}//${options.hostname}${options.port ? `:${options.port}` : ""}${options.path}

Please double check that your authentication token is correct. Due to security reasons, actual status maybe not reported, but 404.
`));
          return;
        } else if (response.statusCode === 204) {
          resolve();
          return;
        }
        const code = (_a = response.statusCode) !== null && _a !== void 0 ? _a : 0;
        const shouldRedirect = code >= 300 && code < 400;
        const redirectUrl = safeGetHeader(response, "location");
        if (shouldRedirect && redirectUrl != null) {
          if (redirectCount > this.maxRedirects) {
            reject(this.createMaxRedirectError());
            return;
          }
          this.doApiRequest(_HttpExecutor.prepareRedirectUrlOptions(redirectUrl, options), cancellationToken, requestProcessor, redirectCount).then(resolve).catch(reject);
          return;
        }
        response.setEncoding("utf8");
        let data = "";
        response.on("error", reject);
        response.on("data", (chunk) => data += chunk);
        response.on("end", () => {
          try {
            if (response.statusCode != null && response.statusCode >= 400) {
              const contentType = safeGetHeader(response, "content-type");
              const isJson = contentType != null && (Array.isArray(contentType) ? contentType.find((it) => it.includes("json")) != null : contentType.includes("json"));
              reject(createHttpError(response, `method: ${options.method || "GET"} url: ${options.protocol || "https:"}//${options.hostname}${options.port ? `:${options.port}` : ""}${options.path}

          Data:
          ${isJson ? safeStringifyJson(JSON.parse(data)) : data}
          `));
            } else {
              resolve(data.length === 0 ? null : data);
            }
          } catch (e) {
            reject(e);
          }
        });
      }
      async downloadToBuffer(url, options) {
        return await options.cancellationToken.createPromise((resolve, reject, onCancel) => {
          const responseChunks = [];
          const requestOptions = {
            headers: options.headers || void 0,
            // because PrivateGitHubProvider requires HttpExecutor.prepareRedirectUrlOptions logic, so, we need to redirect manually
            redirect: "manual"
          };
          configureRequestUrl(url, requestOptions);
          configureRequestOptions(requestOptions);
          this.doDownload(requestOptions, {
            destination: null,
            options,
            onCancel,
            callback: (error) => {
              if (error == null) {
                resolve(Buffer.concat(responseChunks));
              } else {
                reject(error);
              }
            },
            responseHandler: (response, callback) => {
              let receivedLength = 0;
              response.on("data", (chunk) => {
                receivedLength += chunk.length;
                if (receivedLength > 524288e3) {
                  callback(new Error("Maximum allowed size is 500 MB"));
                  return;
                }
                responseChunks.push(chunk);
              });
              response.on("end", () => {
                callback(null);
              });
            }
          }, 0);
        });
      }
      doDownload(requestOptions, options, redirectCount) {
        const request = this.createRequest(requestOptions, (response) => {
          if (response.statusCode >= 400) {
            options.callback(new Error(`Cannot download "${requestOptions.protocol || "https:"}//${requestOptions.hostname}${requestOptions.path}", status ${response.statusCode}: ${response.statusMessage}`));
            return;
          }
          response.on("error", options.callback);
          const redirectUrl = safeGetHeader(response, "location");
          if (redirectUrl != null) {
            if (redirectCount < this.maxRedirects) {
              this.doDownload(_HttpExecutor.prepareRedirectUrlOptions(redirectUrl, requestOptions), options, redirectCount++);
            } else {
              options.callback(this.createMaxRedirectError());
            }
            return;
          }
          if (options.responseHandler == null) {
            configurePipes(options, response);
          } else {
            options.responseHandler(response, options.callback);
          }
        });
        this.addErrorAndTimeoutHandlers(request, options.callback, requestOptions.timeout);
        this.addRedirectHandlers(request, requestOptions, options.callback, redirectCount, (requestOptions2) => {
          this.doDownload(requestOptions2, options, redirectCount++);
        });
        request.end();
      }
      createMaxRedirectError() {
        return new Error(`Too many redirects (> ${this.maxRedirects})`);
      }
      addTimeOutHandler(request, callback, timeout) {
        request.on("socket", (socket) => {
          socket.setTimeout(timeout, () => {
            request.abort();
            callback(new Error("Request timed out"));
          });
        });
      }
      static prepareRedirectUrlOptions(redirectUrl, options) {
        const newOptions = configureRequestOptionsFromUrl(redirectUrl, { ...options });
        const headers = newOptions.headers;
        if (headers == null) {
          return newOptions;
        }
        const originalUrl = _HttpExecutor.reconstructOriginalUrl(options);
        const parsedRedirectUrl = parseUrl(redirectUrl, options);
        if (_HttpExecutor.isCrossOriginRedirect(originalUrl, parsedRedirectUrl)) {
          if (debug.enabled) {
            debug(`Cross-origin redirect (${originalUrl.host} \u2192 ${parsedRedirectUrl.host}): stripping sensitive headers`);
          }
          for (const key of Object.keys(headers)) {
            if (SENSITIVE_REDIRECT_HEADERS.has(normalizeName(key))) {
              delete headers[key];
            }
          }
        }
        return newOptions;
      }
      static reconstructOriginalUrl(options) {
        const protocol = options.protocol || "https:";
        if (!options.hostname) {
          throw new Error("Missing hostname in request options");
        }
        const hostname = options.hostname;
        const port = options.port ? `:${options.port}` : "";
        const path2 = options.path || "/";
        return new url_1.URL(`${protocol}//${hostname}${port}${path2}`);
      }
      static isCrossOriginRedirect(originalUrl, redirectUrl) {
        if (originalUrl.hostname.toLowerCase() !== redirectUrl.hostname.toLowerCase()) {
          return true;
        }
        if (originalUrl.protocol === "http:" && // This can be replaced with `!originalUrl.port`, but for the sake of clarity.
        ["80", ""].includes(originalUrl.port) && redirectUrl.protocol === "https:" && // This can be replaced with `!redirectUrl.port`, but for the sake of clarity.
        ["443", ""].includes(redirectUrl.port)) {
          return false;
        }
        if (originalUrl.protocol !== redirectUrl.protocol) {
          return true;
        }
        const originalPort = originalUrl.port;
        const redirectPort = redirectUrl.port;
        return originalPort !== redirectPort;
      }
      static async retryOnServerError(task, maxRetries = 3) {
        for (let attemptNumber = 0; ; attemptNumber++) {
          try {
            return await task();
          } catch (e) {
            if (attemptNumber < maxRetries && (e instanceof HttpError && e.isServerError() || e.code === "EPIPE")) {
              await new Promise((r) => setTimeout(r, 1e3 * (attemptNumber + 1)));
              continue;
            }
            throw e;
          }
        }
      }
    };
    exports2.HttpExecutor = HttpExecutor;
    function parseUrl(url, options) {
      try {
        return new url_1.URL(url);
      } catch {
        const hostname = options.hostname;
        const protocol = options.protocol || "https:";
        const port = options.port ? `:${options.port}` : "";
        const baseUrl = `${protocol}//${hostname}${port}`;
        return new url_1.URL(url, baseUrl);
      }
    }
    function configureRequestOptionsFromUrl(url, options) {
      const result = configureRequestOptions(options);
      const parsedUrl = parseUrl(url, options);
      configureRequestUrl(parsedUrl, result);
      return result;
    }
    function configureRequestUrl(url, options) {
      options.protocol = url.protocol;
      options.hostname = url.hostname;
      if (url.port) {
        options.port = url.port;
      } else if (options.port) {
        delete options.port;
      }
      options.path = url.pathname + url.search;
    }
    var DigestTransform = class extends stream_1.Transform {
      // noinspection JSUnusedGlobalSymbols
      get actual() {
        return this._actual;
      }
      constructor(expected, algorithm = "sha512", encoding = "base64") {
        super();
        this.expected = expected;
        this.algorithm = algorithm;
        this.encoding = encoding;
        this._actual = null;
        this.isValidateOnEnd = true;
        this.digester = (0, crypto_1.createHash)(algorithm);
      }
      // noinspection JSUnusedGlobalSymbols
      _transform(chunk, encoding, callback) {
        this.digester.update(chunk);
        callback(null, chunk);
      }
      // noinspection JSUnusedGlobalSymbols
      _flush(callback) {
        this._actual = this.digester.digest(this.encoding);
        if (this.isValidateOnEnd) {
          try {
            this.validate();
          } catch (e) {
            callback(e);
            return;
          }
        }
        callback(null);
      }
      validate() {
        if (this._actual == null) {
          throw (0, error_1.newError)("Not finished yet", "ERR_STREAM_NOT_FINISHED");
        }
        if (this._actual !== this.expected) {
          throw (0, error_1.newError)(`${this.algorithm} checksum mismatch, expected ${this.expected}, got ${this._actual}`, "ERR_CHECKSUM_MISMATCH");
        }
        return null;
      }
    };
    exports2.DigestTransform = DigestTransform;
    function checkSha2(sha2Header, sha2, callback) {
      if (sha2Header != null && sha2 != null && sha2Header !== sha2) {
        callback(new Error(`checksum mismatch: expected ${sha2} but got ${sha2Header} (X-Checksum-Sha2 header)`));
        return false;
      }
      return true;
    }
    function safeGetHeader(response, headerKey) {
      const value = response.headers[headerKey];
      if (value == null) {
        return null;
      } else if (Array.isArray(value)) {
        return value.length === 0 ? null : value[value.length - 1];
      } else {
        return value;
      }
    }
    function configurePipes(options, response) {
      if (!checkSha2(safeGetHeader(response, "X-Checksum-Sha2"), options.options.sha2, options.callback)) {
        return;
      }
      const streams = [];
      if (options.options.onProgress != null) {
        const contentLength = safeGetHeader(response, "content-length");
        if (contentLength != null) {
          streams.push(new ProgressCallbackTransform_1.ProgressCallbackTransform(parseInt(contentLength, 10), options.options.cancellationToken, options.options.onProgress));
        }
      }
      const sha512 = options.options.sha512;
      if (sha512 != null) {
        streams.push(new DigestTransform(sha512, "sha512", sha512.length === 128 && !sha512.includes("+") && !sha512.includes("Z") && !sha512.includes("=") ? "hex" : "base64"));
      } else if (options.options.sha2 != null) {
        streams.push(new DigestTransform(options.options.sha2, "sha256", "hex"));
      }
      const fileOut = (0, fs_1.createWriteStream)(options.destination);
      streams.push(fileOut);
      let lastStream = response;
      for (const stream of streams) {
        stream.on("error", (error) => {
          fileOut.close();
          if (!options.options.cancellationToken.cancelled) {
            options.callback(error);
          }
        });
        lastStream = lastStream.pipe(stream);
      }
      fileOut.on("finish", () => {
        ;
        fileOut.close(options.callback);
      });
    }
    function configureRequestOptions(options, token, method) {
      if (method != null) {
        options.method = method;
      }
      options.headers = { ...options.headers };
      const headers = options.headers;
      if (token != null) {
        ;
        headers.authorization = token.startsWith("Basic") || token.startsWith("Bearer") ? token : `token ${token}`;
      }
      if (headers["User-Agent"] == null) {
        headers["User-Agent"] = "electron-builder";
      }
      if (method == null || method === "GET" || headers["Cache-Control"] == null) {
        headers["Cache-Control"] = "no-cache";
      }
      if (options.protocol == null && process.versions.electron != null) {
        options.protocol = "https:";
      }
      return options;
    }
    function isSensitiveFieldName(name) {
      const normalized = normalizeName(name);
      return SENSITIVE_FIELD_PATTERNS.some((p) => normalized.includes(p)) || SENSITIVE_FIELD_SUFFIXES.some((s) => normalized.endsWith(s));
    }
    function hashSensitiveValue(value) {
      return `${(0, crypto_1.createHash)("sha256").update(value).digest("hex")} (sha256 hash)`;
    }
    function safeStringifyJson(data, skippedNames) {
      return JSON.stringify(data, (name, value) => {
        if (isSensitiveFieldName(name) || skippedNames != null && skippedNames.has(name)) {
          return typeof value === "string" ? hashSensitiveValue(value) : "<stripped sensitive data>";
        }
        return value;
      }, 2);
    }
  }
});

// node_modules/.pnpm/builder-util-runtime@9.7.0/node_modules/builder-util-runtime/out/MemoLazy.js
var require_MemoLazy = __commonJS({
  "node_modules/.pnpm/builder-util-runtime@9.7.0/node_modules/builder-util-runtime/out/MemoLazy.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.MemoLazy = void 0;
    var MemoLazy = class {
      constructor(selector, creator) {
        this.selector = selector;
        this.creator = creator;
        this.selected = void 0;
        this._value = void 0;
      }
      get hasValue() {
        return this._value !== void 0;
      }
      get value() {
        const selected = this.selector();
        if (this._value !== void 0 && equals(this.selected, selected)) {
          return this._value;
        }
        this.selected = selected;
        const result = this.creator(selected);
        this.value = result;
        return result;
      }
      set value(value) {
        this._value = value;
      }
    };
    exports2.MemoLazy = MemoLazy;
    function equals(firstValue, secondValue) {
      const isFirstObject = typeof firstValue === "object" && firstValue !== null;
      const isSecondObject = typeof secondValue === "object" && secondValue !== null;
      if (isFirstObject && isSecondObject) {
        const keys1 = Object.keys(firstValue);
        const keys2 = Object.keys(secondValue);
        return keys1.length === keys2.length && keys1.every((key) => equals(firstValue[key], secondValue[key]));
      }
      return firstValue === secondValue;
    }
  }
});

// node_modules/.pnpm/builder-util-runtime@9.7.0/node_modules/builder-util-runtime/out/publishOptions.js
var require_publishOptions = __commonJS({
  "node_modules/.pnpm/builder-util-runtime@9.7.0/node_modules/builder-util-runtime/out/publishOptions.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.githubUrl = githubUrl;
    exports2.githubTagPrefix = githubTagPrefix;
    exports2.getS3LikeProviderBaseUrl = getS3LikeProviderBaseUrl;
    function githubUrl(options, defaultHost = "github.com") {
      return `${options.protocol || "https"}://${options.host || defaultHost}`;
    }
    function githubTagPrefix(options) {
      var _a;
      if (options.tagNamePrefix) {
        return options.tagNamePrefix;
      }
      if ((_a = options.vPrefixedTagName) !== null && _a !== void 0 ? _a : true) {
        return "v";
      }
      return "";
    }
    function getS3LikeProviderBaseUrl(configuration) {
      const provider = configuration.provider;
      if (provider === "s3") {
        return s3Url(configuration);
      }
      if (provider === "spaces") {
        return spacesUrl(configuration);
      }
      throw new Error(`Not supported provider: ${provider}`);
    }
    function s3Url(options) {
      let url;
      if (options.accelerate == true) {
        url = `https://${options.bucket}.s3-accelerate.amazonaws.com`;
      } else if (options.endpoint != null) {
        url = `${options.endpoint}/${options.bucket}`;
      } else if (options.bucket.includes(".")) {
        if (options.region == null) {
          throw new Error(`Bucket name "${options.bucket}" includes a dot, but S3 region is missing`);
        }
        if (options.region === "us-east-1") {
          url = `https://s3.amazonaws.com/${options.bucket}`;
        } else {
          url = `https://s3-${options.region}.amazonaws.com/${options.bucket}`;
        }
      } else if (options.region === "cn-north-1") {
        url = `https://${options.bucket}.s3.${options.region}.amazonaws.com.cn`;
      } else {
        url = `https://${options.bucket}.s3.amazonaws.com`;
      }
      return appendPath(url, options.path);
    }
    function appendPath(url, p) {
      if (p != null && p.length > 0) {
        if (!p.startsWith("/")) {
          url += "/";
        }
        url += p;
      }
      return url;
    }
    function spacesUrl(options) {
      if (options.name == null) {
        throw new Error(`name is missing`);
      }
      if (options.region == null) {
        throw new Error(`region is missing`);
      }
      return appendPath(`https://${options.name}.${options.region}.digitaloceanspaces.com`, options.path);
    }
  }
});

// node_modules/.pnpm/builder-util-runtime@9.7.0/node_modules/builder-util-runtime/out/retry.js
var require_retry = __commonJS({
  "node_modules/.pnpm/builder-util-runtime@9.7.0/node_modules/builder-util-runtime/out/retry.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.retry = retry;
    var CancellationToken_1 = require_CancellationToken();
    async function retry(task, options) {
      var _a;
      const { retries: retryCount, interval, backoff = 0, attempt = 0, shouldRetry, cancellationToken = new CancellationToken_1.CancellationToken() } = options;
      try {
        return await task();
      } catch (error) {
        if (await Promise.resolve((_a = shouldRetry === null || shouldRetry === void 0 ? void 0 : shouldRetry(error)) !== null && _a !== void 0 ? _a : true) && retryCount > 0 && !cancellationToken.cancelled) {
          await new Promise((resolve) => setTimeout(resolve, interval + backoff * attempt));
          return await retry(task, { ...options, retries: retryCount - 1, attempt: attempt + 1 });
        } else {
          throw error;
        }
      }
    }
  }
});

// node_modules/.pnpm/builder-util-runtime@9.7.0/node_modules/builder-util-runtime/out/rfc2253Parser.js
var require_rfc2253Parser = __commonJS({
  "node_modules/.pnpm/builder-util-runtime@9.7.0/node_modules/builder-util-runtime/out/rfc2253Parser.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.parseDn = parseDn;
    function parseDn(seq) {
      let quoted = false;
      let key = null;
      let token = "";
      let nextNonSpace = 0;
      seq = seq.trim();
      const result = /* @__PURE__ */ new Map();
      for (let i = 0; i <= seq.length; i++) {
        if (i === seq.length) {
          if (key !== null) {
            result.set(key, token);
          }
          break;
        }
        const ch = seq[i];
        if (quoted) {
          if (ch === '"') {
            quoted = false;
            continue;
          }
        } else {
          if (ch === '"') {
            quoted = true;
            continue;
          }
          if (ch === "\\") {
            i++;
            const ord = parseInt(seq.slice(i, i + 2), 16);
            if (Number.isNaN(ord)) {
              token += seq[i];
            } else {
              i++;
              token += String.fromCharCode(ord);
            }
            continue;
          }
          if (key === null && ch === "=") {
            key = token;
            token = "";
            continue;
          }
          if (ch === "," || ch === ";" || ch === "+") {
            if (key !== null) {
              result.set(key, token);
            }
            key = null;
            token = "";
            continue;
          }
        }
        if (ch === " " && !quoted) {
          if (token.length === 0) {
            continue;
          }
          if (i > nextNonSpace) {
            let j = i;
            while (seq[j] === " ") {
              j++;
            }
            nextNonSpace = j;
          }
          if (nextNonSpace >= seq.length || seq[nextNonSpace] === "," || seq[nextNonSpace] === ";" || key === null && seq[nextNonSpace] === "=" || key !== null && seq[nextNonSpace] === "+") {
            i = nextNonSpace - 1;
            continue;
          }
        }
        token += ch;
      }
      return result;
    }
  }
});

// node_modules/.pnpm/builder-util-runtime@9.7.0/node_modules/builder-util-runtime/out/uuid.js
var require_uuid = __commonJS({
  "node_modules/.pnpm/builder-util-runtime@9.7.0/node_modules/builder-util-runtime/out/uuid.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.nil = exports2.UUID = void 0;
    var crypto_1 = require("crypto");
    var error_1 = require_error();
    var invalidName = "options.name must be either a string or a Buffer";
    var randomHost = (0, crypto_1.randomBytes)(16);
    randomHost[0] = randomHost[0] | 1;
    var hex2byte = {};
    var byte2hex = [];
    for (let i = 0; i < 256; i++) {
      const hex = (i + 256).toString(16).substr(1);
      hex2byte[hex] = i;
      byte2hex[i] = hex;
    }
    var UUID = class _UUID {
      constructor(uuid) {
        this.ascii = null;
        this.binary = null;
        const check = _UUID.check(uuid);
        if (!check) {
          throw new Error("not a UUID");
        }
        this.version = check.version;
        if (check.format === "ascii") {
          this.ascii = uuid;
        } else {
          this.binary = uuid;
        }
      }
      static v5(name, namespace) {
        return uuidNamed(name, "sha1", 80, namespace);
      }
      toString() {
        if (this.ascii == null) {
          this.ascii = stringify(this.binary);
        }
        return this.ascii;
      }
      inspect() {
        return `UUID v${this.version} ${this.toString()}`;
      }
      static check(uuid, offset = 0) {
        if (typeof uuid === "string") {
          uuid = uuid.toLowerCase();
          if (!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-([a-f0-9]{12})$/.test(uuid)) {
            return false;
          }
          if (uuid === "00000000-0000-0000-0000-000000000000") {
            return { version: void 0, variant: "nil", format: "ascii" };
          }
          return {
            version: (hex2byte[uuid[14] + uuid[15]] & 240) >> 4,
            variant: getVariant((hex2byte[uuid[19] + uuid[20]] & 224) >> 5),
            format: "ascii"
          };
        }
        if (Buffer.isBuffer(uuid)) {
          if (uuid.length < offset + 16) {
            return false;
          }
          let i = 0;
          for (; i < 16; i++) {
            if (uuid[offset + i] !== 0) {
              break;
            }
          }
          if (i === 16) {
            return { version: void 0, variant: "nil", format: "binary" };
          }
          return {
            version: (uuid[offset + 6] & 240) >> 4,
            variant: getVariant((uuid[offset + 8] & 224) >> 5),
            format: "binary"
          };
        }
        throw (0, error_1.newError)("Unknown type of uuid", "ERR_UNKNOWN_UUID_TYPE");
      }
      // read stringified uuid into a Buffer
      static parse(input) {
        const buffer = Buffer.allocUnsafe(16);
        let j = 0;
        for (let i = 0; i < 16; i++) {
          buffer[i] = hex2byte[input[j++] + input[j++]];
          if (i === 3 || i === 5 || i === 7 || i === 9) {
            j += 1;
          }
        }
        return buffer;
      }
    };
    exports2.UUID = UUID;
    UUID.OID = UUID.parse("6ba7b812-9dad-11d1-80b4-00c04fd430c8");
    function getVariant(bits) {
      switch (bits) {
        case 0:
        case 1:
        case 3:
          return "ncs";
        case 4:
        case 5:
          return "rfc4122";
        case 6:
          return "microsoft";
        default:
          return "future";
      }
    }
    var UuidEncoding;
    (function(UuidEncoding2) {
      UuidEncoding2[UuidEncoding2["ASCII"] = 0] = "ASCII";
      UuidEncoding2[UuidEncoding2["BINARY"] = 1] = "BINARY";
      UuidEncoding2[UuidEncoding2["OBJECT"] = 2] = "OBJECT";
    })(UuidEncoding || (UuidEncoding = {}));
    function uuidNamed(name, hashMethod, version, namespace, encoding = UuidEncoding.ASCII) {
      const hash = (0, crypto_1.createHash)(hashMethod);
      const nameIsNotAString = typeof name !== "string";
      if (nameIsNotAString && !Buffer.isBuffer(name)) {
        throw (0, error_1.newError)(invalidName, "ERR_INVALID_UUID_NAME");
      }
      hash.update(namespace);
      hash.update(name);
      const buffer = hash.digest();
      let result;
      switch (encoding) {
        case UuidEncoding.BINARY:
          buffer[6] = buffer[6] & 15 | version;
          buffer[8] = buffer[8] & 63 | 128;
          result = buffer;
          break;
        case UuidEncoding.OBJECT:
          buffer[6] = buffer[6] & 15 | version;
          buffer[8] = buffer[8] & 63 | 128;
          result = new UUID(buffer);
          break;
        default:
          result = byte2hex[buffer[0]] + byte2hex[buffer[1]] + byte2hex[buffer[2]] + byte2hex[buffer[3]] + "-" + byte2hex[buffer[4]] + byte2hex[buffer[5]] + "-" + byte2hex[buffer[6] & 15 | version] + byte2hex[buffer[7]] + "-" + byte2hex[buffer[8] & 63 | 128] + byte2hex[buffer[9]] + "-" + byte2hex[buffer[10]] + byte2hex[buffer[11]] + byte2hex[buffer[12]] + byte2hex[buffer[13]] + byte2hex[buffer[14]] + byte2hex[buffer[15]];
          break;
      }
      return result;
    }
    function stringify(buffer) {
      return byte2hex[buffer[0]] + byte2hex[buffer[1]] + byte2hex[buffer[2]] + byte2hex[buffer[3]] + "-" + byte2hex[buffer[4]] + byte2hex[buffer[5]] + "-" + byte2hex[buffer[6]] + byte2hex[buffer[7]] + "-" + byte2hex[buffer[8]] + byte2hex[buffer[9]] + "-" + byte2hex[buffer[10]] + byte2hex[buffer[11]] + byte2hex[buffer[12]] + byte2hex[buffer[13]] + byte2hex[buffer[14]] + byte2hex[buffer[15]];
    }
    exports2.nil = new UUID("00000000-0000-0000-0000-000000000000");
  }
});

// node_modules/.pnpm/sax@1.6.1/node_modules/sax/lib/sax.js
var require_sax = __commonJS({
  "node_modules/.pnpm/sax@1.6.1/node_modules/sax/lib/sax.js"(exports2) {
    (function(sax) {
      sax.parser = function(strict, opt) {
        return new SAXParser(strict, opt);
      };
      sax.SAXParser = SAXParser;
      sax.SAXStream = SAXStream;
      sax.createStream = createStream;
      sax.MAX_BUFFER_LENGTH = 64 * 1024;
      var buffers = [
        "comment",
        "sgmlDecl",
        "textNode",
        "tagName",
        "doctype",
        "procInstName",
        "procInstBody",
        "entity",
        "attribName",
        "attribValue",
        "cdata",
        "script"
      ];
      sax.EVENTS = [
        "text",
        "processinginstruction",
        "sgmldeclaration",
        "doctype",
        "comment",
        "opentagstart",
        "attribute",
        "opentag",
        "closetag",
        "opencdata",
        "cdata",
        "closecdata",
        "error",
        "end",
        "ready",
        "script",
        "opennamespace",
        "closenamespace"
      ];
      function SAXParser(strict, opt) {
        if (!(this instanceof SAXParser)) {
          return new SAXParser(strict, opt);
        }
        var parser = this;
        clearBuffers(parser);
        parser.q = parser.c = "";
        parser.bufferCheckPosition = sax.MAX_BUFFER_LENGTH;
        parser.encoding = null;
        parser.opt = opt || {};
        parser.opt.lowercase = parser.opt.lowercase || parser.opt.lowercasetags;
        parser.looseCase = parser.opt.lowercase ? "toLowerCase" : "toUpperCase";
        parser.opt.maxEntityCount = parser.opt.maxEntityCount || 512;
        parser.opt.maxEntityDepth = parser.opt.maxEntityDepth || 4;
        parser.entityCount = parser.entityDepth = 0;
        parser.tags = [];
        parser.closed = parser.closedRoot = parser.sawRoot = false;
        parser.tag = parser.error = null;
        parser.strict = !!strict;
        parser.noscript = !!(strict || parser.opt.noscript);
        parser.state = S.BEGIN;
        parser.strictEntities = parser.opt.strictEntities;
        parser.ENTITIES = parser.strictEntities ? Object.create(sax.XML_ENTITIES) : Object.create(sax.ENTITIES);
        parser.attribList = [];
        if (parser.opt.xmlns) {
          parser.ns = Object.create(rootNS);
        }
        if (parser.opt.unquotedAttributeValues === void 0) {
          parser.opt.unquotedAttributeValues = !strict;
        }
        parser.trackPosition = parser.opt.position !== false;
        if (parser.trackPosition) {
          parser.position = parser.line = parser.column = 0;
        }
        emit(parser, "onready");
      }
      if (!Object.create) {
        Object.create = function(o) {
          function F() {
          }
          F.prototype = o;
          var newf = new F();
          return newf;
        };
      }
      if (!Object.keys) {
        Object.keys = function(o) {
          var a = [];
          for (var i in o) if (o.hasOwnProperty(i)) a.push(i);
          return a;
        };
      }
      function checkBufferLength(parser) {
        var maxAllowed = Math.max(sax.MAX_BUFFER_LENGTH, 10);
        var maxActual = 0;
        for (var i = 0, l = buffers.length; i < l; i++) {
          var len = parser[buffers[i]].length;
          if (len > maxAllowed) {
            switch (buffers[i]) {
              case "textNode":
                closeText(parser);
                break;
              case "cdata":
                emitNode(parser, "oncdata", parser.cdata);
                parser.cdata = "";
                break;
              case "script":
                emitNode(parser, "onscript", parser.script);
                parser.script = "";
                break;
              default:
                error(parser, "Max buffer length exceeded: " + buffers[i]);
            }
          }
          maxActual = Math.max(maxActual, len);
        }
        var m = sax.MAX_BUFFER_LENGTH - maxActual;
        parser.bufferCheckPosition = m + parser.position;
      }
      function clearBuffers(parser) {
        for (var i = 0, l = buffers.length; i < l; i++) {
          parser[buffers[i]] = "";
        }
      }
      function flushBuffers(parser) {
        closeText(parser);
        if (parser.cdata !== "") {
          emitNode(parser, "oncdata", parser.cdata);
          parser.cdata = "";
        }
        if (parser.script !== "") {
          emitNode(parser, "onscript", parser.script);
          parser.script = "";
        }
      }
      SAXParser.prototype = {
        end: function() {
          end(this);
        },
        write,
        resume: function() {
          this.error = null;
          return this;
        },
        close: function() {
          return this.write(null);
        },
        flush: function() {
          flushBuffers(this);
        }
      };
      var Stream;
      try {
        Stream = require("stream").Stream;
      } catch (ex) {
        Stream = function() {
        };
      }
      if (!Stream) Stream = function() {
      };
      var streamWraps = sax.EVENTS.filter(function(ev) {
        return ev !== "error" && ev !== "end";
      });
      function createStream(strict, opt) {
        return new SAXStream(strict, opt);
      }
      function determineBufferEncoding(data, isEnd) {
        if (data.length >= 2) {
          if (data[0] === 255 && data[1] === 254) {
            return "utf-16le";
          }
          if (data[0] === 254 && data[1] === 255) {
            return "utf-16be";
          }
        }
        if (data.length >= 3 && data[0] === 239 && data[1] === 187 && data[2] === 191) {
          return "utf8";
        }
        if (data.length >= 4) {
          if (data[0] === 60 && data[1] === 0 && data[2] === 63 && data[3] === 0) {
            return "utf-16le";
          }
          if (data[0] === 0 && data[1] === 60 && data[2] === 0 && data[3] === 63) {
            return "utf-16be";
          }
          return "utf8";
        }
        return isEnd ? "utf8" : null;
      }
      function SAXStream(strict, opt) {
        if (!(this instanceof SAXStream)) {
          return new SAXStream(strict, opt);
        }
        Stream.apply(this);
        this._parser = new SAXParser(strict, opt);
        this.writable = true;
        this.readable = true;
        var me = this;
        this._parser.onend = function() {
          me.emit("end");
        };
        this._parser.onerror = function(er) {
          me.emit("error", er);
          me._parser.error = null;
        };
        this._decoder = null;
        this._decoderBuffer = null;
        streamWraps.forEach(function(ev) {
          Object.defineProperty(me, "on" + ev, {
            get: function() {
              return me._parser["on" + ev];
            },
            set: function(h) {
              if (!h) {
                me.removeAllListeners(ev);
                me._parser["on" + ev] = h;
                return h;
              }
              me.on(ev, h);
            },
            enumerable: true,
            configurable: false
          });
        });
      }
      SAXStream.prototype = Object.create(Stream.prototype, {
        constructor: {
          value: SAXStream
        }
      });
      SAXStream.prototype._decodeBuffer = function(data, isEnd) {
        if (this._decoderBuffer) {
          data = Buffer.concat([this._decoderBuffer, data]);
          this._decoderBuffer = null;
        }
        if (!this._decoder) {
          var encoding = determineBufferEncoding(data, isEnd);
          if (!encoding) {
            this._decoderBuffer = data;
            return "";
          }
          this._parser.encoding = encoding;
          this._decoder = new TextDecoder(encoding);
        }
        return this._decoder.decode(data, { stream: !isEnd });
      };
      SAXStream.prototype.write = function(data) {
        if (typeof Buffer === "function" && typeof Buffer.isBuffer === "function" && Buffer.isBuffer(data)) {
          data = this._decodeBuffer(data, false);
        } else if (this._decoderBuffer) {
          var remaining = this._decodeBuffer(Buffer.alloc(0), true);
          if (remaining) {
            this._parser.write(remaining);
            this.emit("data", remaining);
          }
        }
        this._parser.write(data.toString());
        this.emit("data", data);
        return true;
      };
      SAXStream.prototype.end = function(chunk) {
        if (chunk && chunk.length) {
          this.write(chunk);
        }
        if (this._decoderBuffer) {
          var finalChunk = this._decodeBuffer(Buffer.alloc(0), true);
          if (finalChunk) {
            this._parser.write(finalChunk);
            this.emit("data", finalChunk);
          }
        } else if (this._decoder) {
          var remaining = this._decoder.decode();
          if (remaining) {
            this._parser.write(remaining);
            this.emit("data", remaining);
          }
        }
        this._parser.end();
        return true;
      };
      SAXStream.prototype.on = function(ev, handler) {
        var me = this;
        if (!me._parser["on" + ev] && streamWraps.indexOf(ev) !== -1) {
          me._parser["on" + ev] = function() {
            var args = arguments.length === 1 ? [arguments[0]] : Array.apply(null, arguments);
            args.splice(0, 0, ev);
            me.emit.apply(me, args);
          };
        }
        return Stream.prototype.on.call(me, ev, handler);
      };
      var CDATAre = /^\[CDATA\[$/i;
      var DOCTYPEre = /^DOCTYPE$/i;
      var XML_NAMESPACE = "http://www.w3.org/XML/1998/namespace";
      var XMLNS_NAMESPACE = "http://www.w3.org/2000/xmlns/";
      var rootNS = { xml: XML_NAMESPACE, xmlns: XMLNS_NAMESPACE };
      var nameStart = /[:_A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD]/;
      var nameBody = /[:_A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD\u00B7\u0300-\u036F\u203F-\u2040.\d-]/;
      var entityStart = /[#:_A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD]/;
      var entityBody = /[#:_A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD\u00B7\u0300-\u036F\u203F-\u2040.\d-]/;
      function isWhitespace(c) {
        return c === " " || c === "\n" || c === "\r" || c === "	";
      }
      function isQuote(c) {
        return c === '"' || c === "'";
      }
      function isAttribEnd(c) {
        return c === ">" || isWhitespace(c);
      }
      function isMatch(regex, c) {
        return regex.test(c);
      }
      function notMatch(regex, c) {
        return !isMatch(regex, c);
      }
      var S = 0;
      sax.STATE = {
        BEGIN: S++,
        // leading byte order mark or whitespace
        BEGIN_WHITESPACE: S++,
        // leading whitespace
        TEXT: S++,
        // general stuff
        TEXT_ENTITY: S++,
        // &amp and such.
        OPEN_WAKA: S++,
        // <
        SGML_DECL: S++,
        // <!BLARG
        SGML_DECL_QUOTED: S++,
        // <!BLARG foo "bar
        DOCTYPE: S++,
        // <!DOCTYPE
        DOCTYPE_QUOTED: S++,
        // <!DOCTYPE "//blah
        DOCTYPE_DTD: S++,
        // <!DOCTYPE "//blah" [ ...
        DOCTYPE_DTD_QUOTED: S++,
        // <!DOCTYPE "//blah" [ "foo
        COMMENT_STARTING: S++,
        // <!-
        COMMENT: S++,
        // <!--
        COMMENT_ENDING: S++,
        // <!-- blah -
        COMMENT_ENDED: S++,
        // <!-- blah --
        CDATA: S++,
        // <![CDATA[ something
        CDATA_ENDING: S++,
        // ]
        CDATA_ENDING_2: S++,
        // ]]
        PROC_INST: S++,
        // <?hi
        PROC_INST_BODY: S++,
        // <?hi there
        PROC_INST_ENDING: S++,
        // <?hi "there" ?
        OPEN_TAG: S++,
        // <strong
        OPEN_TAG_SLASH: S++,
        // <strong /
        ATTRIB: S++,
        // <a
        ATTRIB_NAME: S++,
        // <a foo
        ATTRIB_NAME_SAW_WHITE: S++,
        // <a foo _
        ATTRIB_VALUE: S++,
        // <a foo=
        ATTRIB_VALUE_QUOTED: S++,
        // <a foo="bar
        ATTRIB_VALUE_CLOSED: S++,
        // <a foo="bar"
        ATTRIB_VALUE_UNQUOTED: S++,
        // <a foo=bar
        ATTRIB_VALUE_ENTITY_Q: S++,
        // <foo bar="&quot;"
        ATTRIB_VALUE_ENTITY_U: S++,
        // <foo bar=&quot
        CLOSE_TAG: S++,
        // </a
        CLOSE_TAG_SAW_WHITE: S++,
        // </a   >
        SCRIPT: S++,
        // <script> ...
        SCRIPT_ENDING: S++
        // <script> ... <
      };
      sax.XML_ENTITIES = Object.assign(/* @__PURE__ */ Object.create(null), {
        amp: "&",
        gt: ">",
        lt: "<",
        quot: '"',
        apos: "'"
      });
      sax.ENTITIES = Object.assign(/* @__PURE__ */ Object.create(null), {
        amp: "&",
        gt: ">",
        lt: "<",
        quot: '"',
        apos: "'",
        AElig: 198,
        Aacute: 193,
        Acirc: 194,
        Agrave: 192,
        Aring: 197,
        Atilde: 195,
        Auml: 196,
        Ccedil: 199,
        ETH: 208,
        Eacute: 201,
        Ecirc: 202,
        Egrave: 200,
        Euml: 203,
        Iacute: 205,
        Icirc: 206,
        Igrave: 204,
        Iuml: 207,
        Ntilde: 209,
        Oacute: 211,
        Ocirc: 212,
        Ograve: 210,
        Oslash: 216,
        Otilde: 213,
        Ouml: 214,
        THORN: 222,
        Uacute: 218,
        Ucirc: 219,
        Ugrave: 217,
        Uuml: 220,
        Yacute: 221,
        aacute: 225,
        acirc: 226,
        aelig: 230,
        agrave: 224,
        aring: 229,
        atilde: 227,
        auml: 228,
        ccedil: 231,
        eacute: 233,
        ecirc: 234,
        egrave: 232,
        eth: 240,
        euml: 235,
        iacute: 237,
        icirc: 238,
        igrave: 236,
        iuml: 239,
        ntilde: 241,
        oacute: 243,
        ocirc: 244,
        ograve: 242,
        oslash: 248,
        otilde: 245,
        ouml: 246,
        szlig: 223,
        thorn: 254,
        uacute: 250,
        ucirc: 251,
        ugrave: 249,
        uuml: 252,
        yacute: 253,
        yuml: 255,
        copy: 169,
        reg: 174,
        nbsp: 160,
        iexcl: 161,
        cent: 162,
        pound: 163,
        curren: 164,
        yen: 165,
        brvbar: 166,
        sect: 167,
        uml: 168,
        ordf: 170,
        laquo: 171,
        not: 172,
        shy: 173,
        macr: 175,
        deg: 176,
        plusmn: 177,
        sup1: 185,
        sup2: 178,
        sup3: 179,
        acute: 180,
        micro: 181,
        para: 182,
        middot: 183,
        cedil: 184,
        ordm: 186,
        raquo: 187,
        frac14: 188,
        frac12: 189,
        frac34: 190,
        iquest: 191,
        times: 215,
        divide: 247,
        OElig: 338,
        oelig: 339,
        Scaron: 352,
        scaron: 353,
        Yuml: 376,
        fnof: 402,
        circ: 710,
        tilde: 732,
        Alpha: 913,
        Beta: 914,
        Gamma: 915,
        Delta: 916,
        Epsilon: 917,
        Zeta: 918,
        Eta: 919,
        Theta: 920,
        Iota: 921,
        Kappa: 922,
        Lambda: 923,
        Mu: 924,
        Nu: 925,
        Xi: 926,
        Omicron: 927,
        Pi: 928,
        Rho: 929,
        Sigma: 931,
        Tau: 932,
        Upsilon: 933,
        Phi: 934,
        Chi: 935,
        Psi: 936,
        Omega: 937,
        alpha: 945,
        beta: 946,
        gamma: 947,
        delta: 948,
        epsilon: 949,
        zeta: 950,
        eta: 951,
        theta: 952,
        iota: 953,
        kappa: 954,
        lambda: 955,
        mu: 956,
        nu: 957,
        xi: 958,
        omicron: 959,
        pi: 960,
        rho: 961,
        sigmaf: 962,
        sigma: 963,
        tau: 964,
        upsilon: 965,
        phi: 966,
        chi: 967,
        psi: 968,
        omega: 969,
        thetasym: 977,
        upsih: 978,
        piv: 982,
        ensp: 8194,
        emsp: 8195,
        thinsp: 8201,
        zwnj: 8204,
        zwj: 8205,
        lrm: 8206,
        rlm: 8207,
        ndash: 8211,
        mdash: 8212,
        lsquo: 8216,
        rsquo: 8217,
        sbquo: 8218,
        ldquo: 8220,
        rdquo: 8221,
        bdquo: 8222,
        dagger: 8224,
        Dagger: 8225,
        bull: 8226,
        hellip: 8230,
        permil: 8240,
        prime: 8242,
        Prime: 8243,
        lsaquo: 8249,
        rsaquo: 8250,
        oline: 8254,
        frasl: 8260,
        euro: 8364,
        image: 8465,
        weierp: 8472,
        real: 8476,
        trade: 8482,
        alefsym: 8501,
        larr: 8592,
        uarr: 8593,
        rarr: 8594,
        darr: 8595,
        harr: 8596,
        crarr: 8629,
        lArr: 8656,
        uArr: 8657,
        rArr: 8658,
        dArr: 8659,
        hArr: 8660,
        forall: 8704,
        part: 8706,
        exist: 8707,
        empty: 8709,
        nabla: 8711,
        isin: 8712,
        notin: 8713,
        ni: 8715,
        prod: 8719,
        sum: 8721,
        minus: 8722,
        lowast: 8727,
        radic: 8730,
        prop: 8733,
        infin: 8734,
        ang: 8736,
        and: 8743,
        or: 8744,
        cap: 8745,
        cup: 8746,
        int: 8747,
        there4: 8756,
        sim: 8764,
        cong: 8773,
        asymp: 8776,
        ne: 8800,
        equiv: 8801,
        le: 8804,
        ge: 8805,
        sub: 8834,
        sup: 8835,
        nsub: 8836,
        sube: 8838,
        supe: 8839,
        oplus: 8853,
        otimes: 8855,
        perp: 8869,
        sdot: 8901,
        lceil: 8968,
        rceil: 8969,
        lfloor: 8970,
        rfloor: 8971,
        lang: 9001,
        rang: 9002,
        loz: 9674,
        spades: 9824,
        clubs: 9827,
        hearts: 9829,
        diams: 9830
      });
      Object.keys(sax.ENTITIES).forEach(function(key) {
        var e = sax.ENTITIES[key];
        var s2 = typeof e === "number" ? String.fromCharCode(e) : e;
        sax.ENTITIES[key] = s2;
      });
      for (var s in sax.STATE) {
        sax.STATE[sax.STATE[s]] = s;
      }
      S = sax.STATE;
      function emit(parser, event, data) {
        parser[event] && parser[event](data);
      }
      function getDeclaredEncoding(body) {
        var match = body && body.match(/(?:^|\s)encoding\s*=\s*(['"])([^'"]+)\1/i);
        return match ? match[2] : null;
      }
      function normalizeEncodingName(encoding) {
        if (!encoding) {
          return null;
        }
        return encoding.toLowerCase().replace(/[^a-z0-9]/g, "");
      }
      function encodingsMatch(detectedEncoding, declaredEncoding) {
        const detected = normalizeEncodingName(detectedEncoding);
        const declared = normalizeEncodingName(declaredEncoding);
        if (!detected || !declared) {
          return true;
        }
        if (declared === "utf16") {
          return detected === "utf16le" || detected === "utf16be";
        }
        return detected === declared;
      }
      function validateXmlDeclarationEncoding(parser, data) {
        if (!parser.strict || !parser.encoding || !data || data.name !== "xml") {
          return;
        }
        var declaredEncoding = getDeclaredEncoding(data.body);
        if (declaredEncoding && !encodingsMatch(parser.encoding, declaredEncoding)) {
          strictFail(
            parser,
            "XML declaration encoding " + declaredEncoding + " does not match detected stream encoding " + parser.encoding.toUpperCase()
          );
        }
      }
      function emitNode(parser, nodeType, data) {
        if (parser.textNode) closeText(parser);
        emit(parser, nodeType, data);
      }
      function closeText(parser) {
        parser.textNode = textopts(parser.opt, parser.textNode);
        if (parser.textNode) emit(parser, "ontext", parser.textNode);
        parser.textNode = "";
      }
      function textopts(opt, text) {
        if (opt.trim) text = text.trim();
        if (opt.normalize) text = text.replace(/\s+/g, " ");
        return text;
      }
      function error(parser, er) {
        closeText(parser);
        if (parser.trackPosition) {
          er += "\nLine: " + parser.line + "\nColumn: " + parser.column + "\nChar: " + parser.c;
        }
        er = new Error(er);
        parser.error = er;
        emit(parser, "onerror", er);
        return parser;
      }
      function end(parser) {
        if (parser.sawRoot && !parser.closedRoot)
          strictFail(parser, "Unclosed root tag");
        if (parser.state !== S.BEGIN && parser.state !== S.BEGIN_WHITESPACE && parser.state !== S.TEXT) {
          error(parser, "Unexpected end");
        }
        closeText(parser);
        parser.c = "";
        parser.closed = true;
        emit(parser, "onend");
        SAXParser.call(parser, parser.strict, parser.opt);
        return parser;
      }
      function strictFail(parser, message) {
        if (typeof parser !== "object" || !(parser instanceof SAXParser)) {
          throw new Error("bad call to strictFail");
        }
        if (parser.strict) {
          error(parser, message);
        }
      }
      function newTag(parser) {
        if (!parser.strict) parser.tagName = parser.tagName[parser.looseCase]();
        var parent = parser.tags[parser.tags.length - 1] || parser;
        var tag = parser.tag = { name: parser.tagName, attributes: {} };
        if (parser.opt.xmlns) {
          tag.ns = parent.ns;
        }
        parser.attribList.length = 0;
        emitNode(parser, "onopentagstart", tag);
      }
      function qname(name, attribute) {
        var i = name.indexOf(":");
        var qualName = i < 0 ? ["", name] : name.split(":");
        var prefix = qualName[0];
        var local = qualName[1];
        if (attribute && name === "xmlns") {
          prefix = "xmlns";
          local = "";
        }
        return { prefix, local };
      }
      function attrib(parser) {
        if (!parser.strict) {
          parser.attribName = parser.attribName[parser.looseCase]();
        }
        if (parser.attribList.indexOf(parser.attribName) !== -1 || parser.tag.attributes.hasOwnProperty(parser.attribName)) {
          parser.attribName = parser.attribValue = "";
          return;
        }
        if (parser.opt.xmlns) {
          var qn = qname(parser.attribName, true);
          var prefix = qn.prefix;
          var local = qn.local;
          if (prefix === "xmlns") {
            if (local === "xml" && parser.attribValue !== XML_NAMESPACE) {
              strictFail(
                parser,
                "xml: prefix must be bound to " + XML_NAMESPACE + "\nActual: " + parser.attribValue
              );
            } else if (local === "xmlns" && parser.attribValue !== XMLNS_NAMESPACE) {
              strictFail(
                parser,
                "xmlns: prefix must be bound to " + XMLNS_NAMESPACE + "\nActual: " + parser.attribValue
              );
            } else {
              var tag = parser.tag;
              var parent = parser.tags[parser.tags.length - 1] || parser;
              if (tag.ns === parent.ns) {
                tag.ns = Object.create(parent.ns);
              }
              tag.ns[local] = parser.attribValue;
            }
          }
          parser.attribList.push([parser.attribName, parser.attribValue]);
        } else {
          parser.tag.attributes[parser.attribName] = parser.attribValue;
          emitNode(parser, "onattribute", {
            name: parser.attribName,
            value: parser.attribValue
          });
        }
        parser.attribName = parser.attribValue = "";
      }
      function openTag(parser, selfClosing) {
        if (parser.opt.xmlns) {
          var tag = parser.tag;
          var qn = qname(parser.tagName);
          tag.prefix = qn.prefix;
          tag.local = qn.local;
          tag.uri = tag.ns[qn.prefix] || "";
          if (tag.prefix && !tag.uri) {
            strictFail(
              parser,
              "Unbound namespace prefix: " + JSON.stringify(parser.tagName)
            );
            tag.uri = qn.prefix;
          }
          var parent = parser.tags[parser.tags.length - 1] || parser;
          if (tag.ns && parent.ns !== tag.ns) {
            Object.keys(tag.ns).forEach(function(p) {
              emitNode(parser, "onopennamespace", {
                prefix: p,
                uri: tag.ns[p]
              });
            });
          }
          for (var i = 0, l = parser.attribList.length; i < l; i++) {
            var nv = parser.attribList[i];
            var name = nv[0];
            var value = nv[1];
            var qualName = qname(name, true);
            var prefix = qualName.prefix;
            var local = qualName.local;
            var uri = prefix === "" ? "" : tag.ns[prefix] || "";
            var a = {
              name,
              value,
              prefix,
              local,
              uri
            };
            if (prefix && prefix !== "xmlns" && !uri) {
              strictFail(
                parser,
                "Unbound namespace prefix: " + JSON.stringify(prefix)
              );
              a.uri = prefix;
            }
            parser.tag.attributes[name] = a;
            emitNode(parser, "onattribute", a);
          }
          parser.attribList.length = 0;
        }
        parser.tag.isSelfClosing = !!selfClosing;
        parser.sawRoot = true;
        parser.tags.push(parser.tag);
        emitNode(parser, "onopentag", parser.tag);
        if (!selfClosing) {
          if (!parser.noscript && parser.tagName.toLowerCase() === "script") {
            parser.state = S.SCRIPT;
          } else {
            parser.state = S.TEXT;
          }
          parser.tag = null;
          parser.tagName = "";
        }
        parser.attribName = parser.attribValue = "";
        parser.attribList.length = 0;
      }
      function closeTag(parser) {
        if (!parser.tagName) {
          strictFail(parser, "Weird empty close tag.");
          parser.textNode += "</>";
          parser.state = S.TEXT;
          return;
        }
        if (parser.script) {
          if (parser.tagName !== "script") {
            parser.script += "</" + parser.tagName + ">";
            parser.tagName = "";
            parser.state = S.SCRIPT;
            return;
          }
          emitNode(parser, "onscript", parser.script);
          parser.script = "";
        }
        var t = parser.tags.length;
        var tagName = parser.tagName;
        if (!parser.strict) {
          tagName = tagName[parser.looseCase]();
        }
        var closeTo = tagName;
        while (t--) {
          var close = parser.tags[t];
          if (close.name !== closeTo) {
            strictFail(parser, "Unexpected close tag");
          } else {
            break;
          }
        }
        if (t < 0) {
          strictFail(parser, "Unmatched closing tag: " + parser.tagName);
          parser.textNode += "</" + parser.tagName + ">";
          parser.state = S.TEXT;
          return;
        }
        parser.tagName = tagName;
        var s2 = parser.tags.length;
        while (s2-- > t) {
          var tag = parser.tag = parser.tags.pop();
          parser.tagName = parser.tag.name;
          emitNode(parser, "onclosetag", parser.tagName);
          var x = {};
          for (var i in tag.ns) {
            x[i] = tag.ns[i];
          }
          var parent = parser.tags[parser.tags.length - 1] || parser;
          if (parser.opt.xmlns && tag.ns !== parent.ns) {
            Object.keys(tag.ns).forEach(function(p) {
              var n = tag.ns[p];
              emitNode(parser, "onclosenamespace", { prefix: p, uri: n });
            });
          }
        }
        if (t === 0) parser.closedRoot = true;
        parser.tagName = parser.attribValue = parser.attribName = "";
        parser.attribList.length = 0;
        parser.state = S.TEXT;
      }
      function parseEntity(parser) {
        var entity = parser.entity;
        var entityLC = entity.toLowerCase();
        var num;
        var numStr = "";
        if (parser.ENTITIES[entity]) {
          return parser.ENTITIES[entity];
        }
        if (parser.ENTITIES[entityLC]) {
          return parser.ENTITIES[entityLC];
        }
        entity = entityLC;
        if (entity.charAt(0) === "#") {
          if (entity.charAt(1) === "x") {
            entity = entity.slice(2);
            num = parseInt(entity, 16);
            numStr = num.toString(16);
          } else {
            entity = entity.slice(1);
            num = parseInt(entity, 10);
            numStr = num.toString(10);
          }
        }
        entity = entity.replace(/^0+/, "");
        if (isNaN(num) || numStr.toLowerCase() !== entity || num < 0 || num > 1114111 || !isXmlChar(num)) {
          strictFail(parser, "Invalid character entity");
          return "&" + parser.entity + ";";
        }
        return String.fromCodePoint(num);
      }
      function isXmlChar(num) {
        return num === 9 || num === 10 || num === 13 || num >= 32 && num <= 55295 || num >= 57344 && num <= 65533 || num >= 65536 && num <= 1114111;
      }
      function beginWhiteSpace(parser, c) {
        if (c === "<") {
          parser.state = S.OPEN_WAKA;
          parser.startTagPosition = parser.position;
        } else if (!isWhitespace(c)) {
          strictFail(parser, "Non-whitespace before first tag.");
          parser.textNode = c;
          parser.state = S.TEXT;
        }
      }
      function charAt(chunk, i) {
        var result = "";
        if (i < chunk.length) {
          result = chunk.charAt(i);
        }
        return result;
      }
      function write(chunk) {
        var parser = this;
        if (this.error) {
          throw this.error;
        }
        if (parser.closed) {
          return error(
            parser,
            "Cannot write after close. Assign an onready handler."
          );
        }
        if (chunk === null) {
          return end(parser);
        }
        if (typeof chunk === "object") {
          chunk = chunk.toString();
        }
        var i = 0;
        var c = "";
        while (true) {
          c = charAt(chunk, i++);
          parser.c = c;
          if (!c) {
            break;
          }
          if (parser.trackPosition) {
            parser.position++;
            if (c === "\n") {
              parser.line++;
              parser.column = 0;
            } else {
              parser.column++;
            }
          }
          switch (parser.state) {
            case S.BEGIN:
              parser.state = S.BEGIN_WHITESPACE;
              if (c === "\uFEFF") {
                continue;
              }
              beginWhiteSpace(parser, c);
              continue;
            case S.BEGIN_WHITESPACE:
              beginWhiteSpace(parser, c);
              continue;
            case S.TEXT:
              if (parser.sawRoot && !parser.closedRoot) {
                var starti = i - 1;
                while (c && c !== "<" && c !== "&") {
                  c = charAt(chunk, i++);
                  if (c && parser.trackPosition) {
                    parser.position++;
                    if (c === "\n") {
                      parser.line++;
                      parser.column = 0;
                    } else {
                      parser.column++;
                    }
                  }
                }
                parser.textNode += chunk.substring(starti, i - 1);
              }
              if (c === "<" && !(parser.sawRoot && parser.closedRoot && !parser.strict)) {
                parser.state = S.OPEN_WAKA;
                parser.startTagPosition = parser.position;
              } else {
                if (!isWhitespace(c) && (!parser.sawRoot || parser.closedRoot)) {
                  strictFail(parser, "Text data outside of root node.");
                }
                if (c === "&") {
                  parser.state = S.TEXT_ENTITY;
                } else {
                  parser.textNode += c;
                }
              }
              continue;
            case S.SCRIPT:
              if (c === "<") {
                parser.state = S.SCRIPT_ENDING;
              } else {
                parser.script += c;
              }
              continue;
            case S.SCRIPT_ENDING:
              if (c === "/") {
                parser.state = S.CLOSE_TAG;
              } else {
                parser.script += "<" + c;
                parser.state = S.SCRIPT;
              }
              continue;
            case S.OPEN_WAKA:
              if (c === "!") {
                parser.state = S.SGML_DECL;
                parser.sgmlDecl = "";
              } else if (isWhitespace(c)) {
              } else if (isMatch(nameStart, c)) {
                parser.state = S.OPEN_TAG;
                parser.tagName = c;
              } else if (c === "/") {
                parser.state = S.CLOSE_TAG;
                parser.tagName = "";
              } else if (c === "?") {
                parser.state = S.PROC_INST;
                parser.procInstName = parser.procInstBody = "";
              } else {
                strictFail(parser, "Unencoded <");
                if (parser.startTagPosition + 1 < parser.position) {
                  var pad = parser.position - parser.startTagPosition;
                  c = new Array(pad).join(" ") + c;
                }
                parser.textNode += "<" + c;
                parser.state = S.TEXT;
              }
              continue;
            case S.SGML_DECL:
              if (parser.sgmlDecl + c === "--") {
                parser.state = S.COMMENT;
                parser.comment = "";
                parser.sgmlDecl = "";
                continue;
              }
              if (parser.doctype && parser.doctype !== true && parser.sgmlDecl) {
                parser.state = S.DOCTYPE_DTD;
                parser.doctype += "<!" + parser.sgmlDecl + c;
                parser.sgmlDecl = "";
              } else if (CDATAre.test(parser.sgmlDecl + c)) {
                emitNode(parser, "onopencdata");
                parser.state = S.CDATA;
                parser.sgmlDecl = "";
                parser.cdata = "";
              } else if (DOCTYPEre.test(parser.sgmlDecl + c)) {
                parser.state = S.DOCTYPE;
                if (parser.doctype || parser.sawRoot) {
                  strictFail(
                    parser,
                    "Inappropriately located doctype declaration"
                  );
                }
                parser.doctype = "";
                parser.sgmlDecl = "";
              } else if (c === ">") {
                emitNode(parser, "onsgmldeclaration", parser.sgmlDecl);
                parser.sgmlDecl = "";
                parser.state = S.TEXT;
              } else if (isQuote(c)) {
                parser.state = S.SGML_DECL_QUOTED;
                parser.sgmlDecl += c;
              } else {
                parser.sgmlDecl += c;
              }
              continue;
            case S.SGML_DECL_QUOTED:
              if (c === parser.q) {
                parser.state = S.SGML_DECL;
                parser.q = "";
              }
              parser.sgmlDecl += c;
              continue;
            case S.DOCTYPE:
              if (c === ">") {
                parser.state = S.TEXT;
                emitNode(parser, "ondoctype", parser.doctype);
                parser.doctype = true;
              } else {
                parser.doctype += c;
                if (c === "[") {
                  parser.state = S.DOCTYPE_DTD;
                } else if (isQuote(c)) {
                  parser.state = S.DOCTYPE_QUOTED;
                  parser.q = c;
                }
              }
              continue;
            case S.DOCTYPE_QUOTED:
              parser.doctype += c;
              if (c === parser.q) {
                parser.q = "";
                parser.state = S.DOCTYPE;
              }
              continue;
            case S.DOCTYPE_DTD:
              if (c === "]") {
                parser.doctype += c;
                parser.state = S.DOCTYPE;
              } else if (c === "<") {
                parser.state = S.OPEN_WAKA;
                parser.startTagPosition = parser.position;
              } else if (isQuote(c)) {
                parser.doctype += c;
                parser.state = S.DOCTYPE_DTD_QUOTED;
                parser.q = c;
              } else {
                parser.doctype += c;
              }
              continue;
            case S.DOCTYPE_DTD_QUOTED:
              parser.doctype += c;
              if (c === parser.q) {
                parser.state = S.DOCTYPE_DTD;
                parser.q = "";
              }
              continue;
            case S.COMMENT:
              if (c === "-") {
                parser.state = S.COMMENT_ENDING;
              } else {
                parser.comment += c;
              }
              continue;
            case S.COMMENT_ENDING:
              if (c === "-") {
                parser.state = S.COMMENT_ENDED;
                parser.comment = textopts(parser.opt, parser.comment);
                if (parser.comment) {
                  emitNode(parser, "oncomment", parser.comment);
                }
                parser.comment = "";
              } else {
                parser.comment += "-" + c;
                parser.state = S.COMMENT;
              }
              continue;
            case S.COMMENT_ENDED:
              if (c !== ">") {
                strictFail(parser, "Malformed comment");
                parser.comment += "--" + c;
                parser.state = S.COMMENT;
              } else if (parser.doctype && parser.doctype !== true) {
                parser.state = S.DOCTYPE_DTD;
              } else {
                parser.state = S.TEXT;
              }
              continue;
            case S.CDATA:
              var starti = i - 1;
              while (c && c !== "]") {
                c = charAt(chunk, i++);
                if (c && parser.trackPosition) {
                  parser.position++;
                  if (c === "\n") {
                    parser.line++;
                    parser.column = 0;
                  } else {
                    parser.column++;
                  }
                }
              }
              parser.cdata += chunk.substring(starti, i - 1);
              if (c === "]") {
                parser.state = S.CDATA_ENDING;
              }
              continue;
            case S.CDATA_ENDING:
              if (c === "]") {
                parser.state = S.CDATA_ENDING_2;
              } else {
                parser.cdata += "]" + c;
                parser.state = S.CDATA;
              }
              continue;
            case S.CDATA_ENDING_2:
              if (c === ">") {
                if (parser.cdata) {
                  emitNode(parser, "oncdata", parser.cdata);
                }
                emitNode(parser, "onclosecdata");
                parser.cdata = "";
                parser.state = S.TEXT;
              } else if (c === "]") {
                parser.cdata += "]";
              } else {
                parser.cdata += "]]" + c;
                parser.state = S.CDATA;
              }
              continue;
            case S.PROC_INST:
              if (c === "?") {
                parser.state = S.PROC_INST_ENDING;
              } else if (isWhitespace(c)) {
                parser.state = S.PROC_INST_BODY;
              } else {
                parser.procInstName += c;
              }
              continue;
            case S.PROC_INST_BODY:
              if (!parser.procInstBody && isWhitespace(c)) {
                continue;
              } else if (c === "?") {
                parser.state = S.PROC_INST_ENDING;
              } else {
                parser.procInstBody += c;
              }
              continue;
            case S.PROC_INST_ENDING:
              if (c === ">") {
                const procInstEndData = {
                  name: parser.procInstName,
                  body: parser.procInstBody
                };
                validateXmlDeclarationEncoding(parser, procInstEndData);
                emitNode(parser, "onprocessinginstruction", procInstEndData);
                parser.procInstName = parser.procInstBody = "";
                parser.state = S.TEXT;
              } else {
                parser.procInstBody += "?" + c;
                parser.state = S.PROC_INST_BODY;
              }
              continue;
            case S.OPEN_TAG:
              if (isMatch(nameBody, c)) {
                parser.tagName += c;
              } else {
                newTag(parser);
                if (c === ">") {
                  openTag(parser);
                } else if (c === "/") {
                  parser.state = S.OPEN_TAG_SLASH;
                } else {
                  if (!isWhitespace(c)) {
                    strictFail(parser, "Invalid character in tag name");
                  }
                  parser.state = S.ATTRIB;
                }
              }
              continue;
            case S.OPEN_TAG_SLASH:
              if (c === ">") {
                openTag(parser, true);
                closeTag(parser);
              } else {
                strictFail(
                  parser,
                  "Forward-slash in opening tag not followed by >"
                );
                parser.state = S.ATTRIB;
              }
              continue;
            case S.ATTRIB:
              if (isWhitespace(c)) {
                continue;
              } else if (c === ">") {
                openTag(parser);
              } else if (c === "/") {
                parser.state = S.OPEN_TAG_SLASH;
              } else if (isMatch(nameStart, c)) {
                parser.attribName = c;
                parser.attribValue = "";
                parser.state = S.ATTRIB_NAME;
              } else {
                strictFail(parser, "Invalid attribute name");
              }
              continue;
            case S.ATTRIB_NAME:
              if (c === "=") {
                parser.state = S.ATTRIB_VALUE;
              } else if (c === ">") {
                strictFail(parser, "Attribute without value");
                parser.attribValue = parser.attribName;
                attrib(parser);
                openTag(parser);
              } else if (isWhitespace(c)) {
                parser.state = S.ATTRIB_NAME_SAW_WHITE;
              } else if (isMatch(nameBody, c)) {
                parser.attribName += c;
              } else {
                strictFail(parser, "Invalid attribute name");
              }
              continue;
            case S.ATTRIB_NAME_SAW_WHITE:
              if (c === "=") {
                parser.state = S.ATTRIB_VALUE;
              } else if (isWhitespace(c)) {
                continue;
              } else {
                strictFail(parser, "Attribute without value");
                parser.tag.attributes[parser.attribName] = "";
                parser.attribValue = "";
                emitNode(parser, "onattribute", {
                  name: parser.attribName,
                  value: ""
                });
                parser.attribName = "";
                if (c === ">") {
                  openTag(parser);
                } else if (isMatch(nameStart, c)) {
                  parser.attribName = c;
                  parser.state = S.ATTRIB_NAME;
                } else {
                  strictFail(parser, "Invalid attribute name");
                  parser.state = S.ATTRIB;
                }
              }
              continue;
            case S.ATTRIB_VALUE:
              if (isWhitespace(c)) {
                continue;
              } else if (isQuote(c)) {
                parser.q = c;
                parser.state = S.ATTRIB_VALUE_QUOTED;
              } else {
                if (!parser.opt.unquotedAttributeValues) {
                  error(parser, "Unquoted attribute value");
                }
                parser.state = S.ATTRIB_VALUE_UNQUOTED;
                parser.attribValue = c;
              }
              continue;
            case S.ATTRIB_VALUE_QUOTED:
              if (c !== parser.q) {
                if (c === "&") {
                  parser.state = S.ATTRIB_VALUE_ENTITY_Q;
                } else {
                  parser.attribValue += c;
                }
                continue;
              }
              attrib(parser);
              parser.q = "";
              parser.state = S.ATTRIB_VALUE_CLOSED;
              continue;
            case S.ATTRIB_VALUE_CLOSED:
              if (isWhitespace(c)) {
                parser.state = S.ATTRIB;
              } else if (c === ">") {
                openTag(parser);
              } else if (c === "/") {
                parser.state = S.OPEN_TAG_SLASH;
              } else if (isMatch(nameStart, c)) {
                strictFail(parser, "No whitespace between attributes");
                parser.attribName = c;
                parser.attribValue = "";
                parser.state = S.ATTRIB_NAME;
              } else {
                strictFail(parser, "Invalid attribute name");
              }
              continue;
            case S.ATTRIB_VALUE_UNQUOTED:
              if (!isAttribEnd(c)) {
                if (c === "&") {
                  parser.state = S.ATTRIB_VALUE_ENTITY_U;
                } else {
                  parser.attribValue += c;
                }
                continue;
              }
              attrib(parser);
              if (c === ">") {
                openTag(parser);
              } else {
                parser.state = S.ATTRIB;
              }
              continue;
            case S.CLOSE_TAG:
              if (!parser.tagName) {
                if (isWhitespace(c)) {
                  continue;
                } else if (notMatch(nameStart, c)) {
                  if (parser.script) {
                    parser.script += "</" + c;
                    parser.state = S.SCRIPT;
                  } else {
                    strictFail(parser, "Invalid tagname in closing tag.");
                  }
                } else {
                  parser.tagName = c;
                }
              } else if (c === ">") {
                closeTag(parser);
              } else if (isMatch(nameBody, c)) {
                parser.tagName += c;
              } else if (parser.script) {
                parser.script += "</" + parser.tagName + c;
                parser.tagName = "";
                parser.state = S.SCRIPT;
              } else {
                if (!isWhitespace(c)) {
                  strictFail(parser, "Invalid tagname in closing tag");
                }
                parser.state = S.CLOSE_TAG_SAW_WHITE;
              }
              continue;
            case S.CLOSE_TAG_SAW_WHITE:
              if (isWhitespace(c)) {
                continue;
              }
              if (c === ">") {
                closeTag(parser);
              } else {
                strictFail(parser, "Invalid characters in closing tag");
              }
              continue;
            case S.TEXT_ENTITY:
            case S.ATTRIB_VALUE_ENTITY_Q:
            case S.ATTRIB_VALUE_ENTITY_U:
              var returnState;
              var buffer;
              switch (parser.state) {
                case S.TEXT_ENTITY:
                  returnState = S.TEXT;
                  buffer = "textNode";
                  break;
                case S.ATTRIB_VALUE_ENTITY_Q:
                  returnState = S.ATTRIB_VALUE_QUOTED;
                  buffer = "attribValue";
                  break;
                case S.ATTRIB_VALUE_ENTITY_U:
                  returnState = S.ATTRIB_VALUE_UNQUOTED;
                  buffer = "attribValue";
                  break;
              }
              if (c === ";") {
                var parsedEntity = parseEntity(parser);
                if (parser.opt.unparsedEntities && !Object.values(sax.XML_ENTITIES).includes(parsedEntity)) {
                  if ((parser.entityCount += 1) > parser.opt.maxEntityCount) {
                    error(
                      parser,
                      "Parsed entity count exceeds max entity count"
                    );
                  }
                  if ((parser.entityDepth += 1) > parser.opt.maxEntityDepth) {
                    error(
                      parser,
                      "Parsed entity depth exceeds max entity depth"
                    );
                  }
                  parser.entity = "";
                  parser.state = returnState;
                  parser.write(parsedEntity);
                  parser.entityDepth -= 1;
                } else {
                  parser[buffer] += parsedEntity;
                  parser.entity = "";
                  parser.state = returnState;
                }
              } else if (isMatch(parser.entity.length ? entityBody : entityStart, c)) {
                parser.entity += c;
              } else {
                strictFail(parser, "Invalid character in entity name");
                parser[buffer] += "&" + parser.entity + c;
                parser.entity = "";
                parser.state = returnState;
              }
              continue;
            default: {
              throw new Error(parser, "Unknown state: " + parser.state);
            }
          }
        }
        if (parser.position >= parser.bufferCheckPosition) {
          checkBufferLength(parser);
        }
        return parser;
      }
      if (!String.fromCodePoint) {
        ;
        (function() {
          var stringFromCharCode = String.fromCharCode;
          var floor = Math.floor;
          var fromCodePoint = function() {
            var MAX_SIZE = 16384;
            var codeUnits = [];
            var highSurrogate;
            var lowSurrogate;
            var index = -1;
            var length = arguments.length;
            if (!length) {
              return "";
            }
            var result = "";
            while (++index < length) {
              var codePoint = Number(arguments[index]);
              if (!isFinite(codePoint) || // `NaN`, `+Infinity`, or `-Infinity`
              codePoint < 0 || // not a valid Unicode code point
              codePoint > 1114111 || // not a valid Unicode code point
              floor(codePoint) !== codePoint) {
                throw RangeError("Invalid code point: " + codePoint);
              }
              if (codePoint <= 65535) {
                codeUnits.push(codePoint);
              } else {
                codePoint -= 65536;
                highSurrogate = (codePoint >> 10) + 55296;
                lowSurrogate = codePoint % 1024 + 56320;
                codeUnits.push(highSurrogate, lowSurrogate);
              }
              if (index + 1 === length || codeUnits.length > MAX_SIZE) {
                result += stringFromCharCode.apply(null, codeUnits);
                codeUnits.length = 0;
              }
            }
            return result;
          };
          if (Object.defineProperty) {
            Object.defineProperty(String, "fromCodePoint", {
              value: fromCodePoint,
              configurable: true,
              writable: true
            });
          } else {
            String.fromCodePoint = fromCodePoint;
          }
        })();
      }
    })(typeof exports2 === "undefined" ? exports2.sax = {} : exports2);
  }
});

// node_modules/.pnpm/builder-util-runtime@9.7.0/node_modules/builder-util-runtime/out/xml.js
var require_xml = __commonJS({
  "node_modules/.pnpm/builder-util-runtime@9.7.0/node_modules/builder-util-runtime/out/xml.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.XElement = void 0;
    exports2.parseXml = parseXml;
    var sax = require_sax();
    var error_1 = require_error();
    var XElement = class {
      constructor(name) {
        this.name = name;
        this.value = "";
        this.attributes = null;
        this.isCData = false;
        this.elements = null;
        if (!name) {
          throw (0, error_1.newError)("Element name cannot be empty", "ERR_XML_ELEMENT_NAME_EMPTY");
        }
        if (!isValidName(name)) {
          throw (0, error_1.newError)(`Invalid element name: ${name}`, "ERR_XML_ELEMENT_INVALID_NAME");
        }
      }
      attribute(name) {
        const result = this.attributes === null ? null : this.attributes[name];
        if (result == null) {
          throw (0, error_1.newError)(`No attribute "${name}"`, "ERR_XML_MISSED_ATTRIBUTE");
        }
        return result;
      }
      removeAttribute(name) {
        if (this.attributes !== null) {
          delete this.attributes[name];
        }
      }
      element(name, ignoreCase = false, errorIfMissed = null) {
        const result = this.elementOrNull(name, ignoreCase);
        if (result === null) {
          throw (0, error_1.newError)(errorIfMissed || `No element "${name}"`, "ERR_XML_MISSED_ELEMENT");
        }
        return result;
      }
      elementOrNull(name, ignoreCase = false) {
        if (this.elements === null) {
          return null;
        }
        for (const element of this.elements) {
          if (isNameEquals(element, name, ignoreCase)) {
            return element;
          }
        }
        return null;
      }
      getElements(name, ignoreCase = false) {
        if (this.elements === null) {
          return [];
        }
        return this.elements.filter((it) => isNameEquals(it, name, ignoreCase));
      }
      elementValueOrEmpty(name, ignoreCase = false) {
        const element = this.elementOrNull(name, ignoreCase);
        return element === null ? "" : element.value;
      }
    };
    exports2.XElement = XElement;
    var NAME_REG_EXP = new RegExp(/^[A-Za-z_][:A-Za-z0-9_-]*$/i);
    function isValidName(name) {
      return NAME_REG_EXP.test(name);
    }
    function isNameEquals(element, name, ignoreCase) {
      const elementName = element.name;
      return elementName === name || ignoreCase === true && elementName.length === name.length && elementName.toLowerCase() === name.toLowerCase();
    }
    function parseXml(data) {
      let rootElement = null;
      const parser = sax.parser(true, {});
      const elements = [];
      parser.onopentag = (saxElement) => {
        const element = new XElement(saxElement.name);
        element.attributes = saxElement.attributes;
        if (rootElement === null) {
          rootElement = element;
        } else {
          const parent = elements[elements.length - 1];
          if (parent.elements == null) {
            parent.elements = [];
          }
          parent.elements.push(element);
        }
        elements.push(element);
      };
      parser.onclosetag = () => {
        elements.pop();
      };
      parser.ontext = (text) => {
        if (elements.length > 0) {
          elements[elements.length - 1].value = text;
        }
      };
      parser.oncdata = (cdata) => {
        const element = elements[elements.length - 1];
        element.value = cdata;
        element.isCData = true;
      };
      parser.onerror = (err) => {
        throw err;
      };
      parser.write(data);
      return rootElement;
    }
  }
});

// node_modules/.pnpm/builder-util-runtime@9.7.0/node_modules/builder-util-runtime/out/objects.js
var require_objects = __commonJS({
  "node_modules/.pnpm/builder-util-runtime@9.7.0/node_modules/builder-util-runtime/out/objects.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.mapToObject = mapToObject;
    exports2.isValidKey = isValidKey;
    exports2.asArray = asArray;
    exports2.deepAssign = deepAssign;
    exports2.objectToArgs = objectToArgs;
    function mapToObject(map) {
      const obj = {};
      for (const [key, value] of map) {
        if (!isValidKey(key)) {
          continue;
        }
        if (value instanceof Map) {
          obj[key] = mapToObject(value);
        } else {
          obj[key] = value;
        }
      }
      return obj;
    }
    function isValidKey(key) {
      const protectedProperties = ["__proto__", "prototype", "constructor"];
      if (protectedProperties.includes(key)) {
        return false;
      }
      return ["string", "number", "symbol", "boolean"].includes(typeof key) || key === null;
    }
    function asArray(v) {
      if (v == null) {
        return [];
      } else if (Array.isArray(v)) {
        return v;
      } else {
        return [v];
      }
    }
    function isObject(x) {
      if (Array.isArray(x)) {
        return false;
      }
      const type = typeof x;
      return type === "object" || type === "function";
    }
    function assignKey(target, from, key) {
      const value = from[key];
      if (value === void 0) {
        return;
      }
      const prevValue = target[key];
      if (prevValue == null || value == null || !isObject(prevValue) || !isObject(value)) {
        if (Array.isArray(prevValue) && Array.isArray(value)) {
          target[key] = Array.from(new Set(prevValue.concat(value)));
        } else {
          target[key] = value;
        }
      } else {
        target[key] = assign(prevValue, value);
      }
    }
    function assign(to, from) {
      if (to !== from) {
        for (const key of Object.getOwnPropertyNames(from)) {
          if (isValidKey(key)) {
            assignKey(to, from, key);
          }
        }
      }
      return to;
    }
    function deepAssign(target, ...objects) {
      for (const o of objects) {
        if (o != null) {
          assign(target, o);
        }
      }
      return target;
    }
    var SAFE_FLAG_NAME_RE = /^[a-zA-Z][a-zA-Z0-9-]*$/;
    var UNSAFE_VALUE_RE = /[\0\r\n]/;
    function objectToArgs(obj) {
      const args = Object.entries(obj).reduce((args2, [name, value]) => {
        if (!isValidKey(name) || value == null) {
          return args2;
        }
        if (!SAFE_FLAG_NAME_RE.test(name)) {
          throw new Error(`objectToArgs: unsafe flag name rejected: ${JSON.stringify(name)}`);
        }
        if (UNSAFE_VALUE_RE.test(value)) {
          throw new Error(`objectToArgs: value for --${name} contains a null byte or newline`);
        }
        return args2.concat([`--${name}`, value]);
      }, []);
      return Object.freeze(args);
    }
  }
});

// node_modules/.pnpm/builder-util-runtime@9.7.0/node_modules/builder-util-runtime/out/index.js
var require_out = __commonJS({
  "node_modules/.pnpm/builder-util-runtime@9.7.0/node_modules/builder-util-runtime/out/index.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.CURRENT_APP_PACKAGE_FILE_NAME = exports2.CURRENT_APP_INSTALLER_FILE_NAME = exports2.objectToArgs = exports2.deepAssign = exports2.asArray = exports2.mapToObject = exports2.isValidKey = exports2.XElement = exports2.parseXml = exports2.UUID = exports2.parseDn = exports2.retry = exports2.githubTagPrefix = exports2.githubUrl = exports2.getS3LikeProviderBaseUrl = exports2.ProgressCallbackTransform = exports2.MemoLazy = exports2.safeStringifyJson = exports2.safeGetHeader = exports2.parseJson = exports2.isSensitiveFieldName = exports2.HttpExecutor = exports2.hashSensitiveValue = exports2.HttpError = exports2.DigestTransform = exports2.createHttpError = exports2.configureRequestUrl = exports2.configureRequestOptionsFromUrl = exports2.configureRequestOptions = exports2.newError = exports2.CancellationToken = exports2.CancellationError = void 0;
    var CancellationToken_1 = require_CancellationToken();
    Object.defineProperty(exports2, "CancellationError", { enumerable: true, get: function() {
      return CancellationToken_1.CancellationError;
    } });
    Object.defineProperty(exports2, "CancellationToken", { enumerable: true, get: function() {
      return CancellationToken_1.CancellationToken;
    } });
    var error_1 = require_error();
    Object.defineProperty(exports2, "newError", { enumerable: true, get: function() {
      return error_1.newError;
    } });
    var httpExecutor_1 = require_httpExecutor();
    Object.defineProperty(exports2, "configureRequestOptions", { enumerable: true, get: function() {
      return httpExecutor_1.configureRequestOptions;
    } });
    Object.defineProperty(exports2, "configureRequestOptionsFromUrl", { enumerable: true, get: function() {
      return httpExecutor_1.configureRequestOptionsFromUrl;
    } });
    Object.defineProperty(exports2, "configureRequestUrl", { enumerable: true, get: function() {
      return httpExecutor_1.configureRequestUrl;
    } });
    Object.defineProperty(exports2, "createHttpError", { enumerable: true, get: function() {
      return httpExecutor_1.createHttpError;
    } });
    Object.defineProperty(exports2, "DigestTransform", { enumerable: true, get: function() {
      return httpExecutor_1.DigestTransform;
    } });
    Object.defineProperty(exports2, "HttpError", { enumerable: true, get: function() {
      return httpExecutor_1.HttpError;
    } });
    Object.defineProperty(exports2, "hashSensitiveValue", { enumerable: true, get: function() {
      return httpExecutor_1.hashSensitiveValue;
    } });
    Object.defineProperty(exports2, "HttpExecutor", { enumerable: true, get: function() {
      return httpExecutor_1.HttpExecutor;
    } });
    Object.defineProperty(exports2, "isSensitiveFieldName", { enumerable: true, get: function() {
      return httpExecutor_1.isSensitiveFieldName;
    } });
    Object.defineProperty(exports2, "parseJson", { enumerable: true, get: function() {
      return httpExecutor_1.parseJson;
    } });
    Object.defineProperty(exports2, "safeGetHeader", { enumerable: true, get: function() {
      return httpExecutor_1.safeGetHeader;
    } });
    Object.defineProperty(exports2, "safeStringifyJson", { enumerable: true, get: function() {
      return httpExecutor_1.safeStringifyJson;
    } });
    var MemoLazy_1 = require_MemoLazy();
    Object.defineProperty(exports2, "MemoLazy", { enumerable: true, get: function() {
      return MemoLazy_1.MemoLazy;
    } });
    var ProgressCallbackTransform_1 = require_ProgressCallbackTransform();
    Object.defineProperty(exports2, "ProgressCallbackTransform", { enumerable: true, get: function() {
      return ProgressCallbackTransform_1.ProgressCallbackTransform;
    } });
    var publishOptions_1 = require_publishOptions();
    Object.defineProperty(exports2, "getS3LikeProviderBaseUrl", { enumerable: true, get: function() {
      return publishOptions_1.getS3LikeProviderBaseUrl;
    } });
    Object.defineProperty(exports2, "githubUrl", { enumerable: true, get: function() {
      return publishOptions_1.githubUrl;
    } });
    Object.defineProperty(exports2, "githubTagPrefix", { enumerable: true, get: function() {
      return publishOptions_1.githubTagPrefix;
    } });
    var retry_1 = require_retry();
    Object.defineProperty(exports2, "retry", { enumerable: true, get: function() {
      return retry_1.retry;
    } });
    var rfc2253Parser_1 = require_rfc2253Parser();
    Object.defineProperty(exports2, "parseDn", { enumerable: true, get: function() {
      return rfc2253Parser_1.parseDn;
    } });
    var uuid_1 = require_uuid();
    Object.defineProperty(exports2, "UUID", { enumerable: true, get: function() {
      return uuid_1.UUID;
    } });
    var xml_1 = require_xml();
    Object.defineProperty(exports2, "parseXml", { enumerable: true, get: function() {
      return xml_1.parseXml;
    } });
    Object.defineProperty(exports2, "XElement", { enumerable: true, get: function() {
      return xml_1.XElement;
    } });
    var objects_1 = require_objects();
    Object.defineProperty(exports2, "isValidKey", { enumerable: true, get: function() {
      return objects_1.isValidKey;
    } });
    Object.defineProperty(exports2, "mapToObject", { enumerable: true, get: function() {
      return objects_1.mapToObject;
    } });
    Object.defineProperty(exports2, "asArray", { enumerable: true, get: function() {
      return objects_1.asArray;
    } });
    Object.defineProperty(exports2, "deepAssign", { enumerable: true, get: function() {
      return objects_1.deepAssign;
    } });
    Object.defineProperty(exports2, "objectToArgs", { enumerable: true, get: function() {
      return objects_1.objectToArgs;
    } });
    exports2.CURRENT_APP_INSTALLER_FILE_NAME = "installer.exe";
    exports2.CURRENT_APP_PACKAGE_FILE_NAME = "package.7z";
  }
});

// node_modules/.pnpm/js-yaml@5.4.1/node_modules/js-yaml/dist/js-yaml.cjs.js
var require_js_yaml_cjs = __commonJS({
  "node_modules/.pnpm/js-yaml@5.4.1/node_modules/js-yaml/dist/js-yaml.cjs.js"(exports2) {
    Object.defineProperty(exports2, Symbol.toStringTag, { value: "Module" });
    var NOT_RESOLVED = /* @__PURE__ */ Symbol("NOT_RESOLVED");
    function defineScalarTag(tagName, options) {
      var _options$implicit, _options$matchByTagPr, _options$implicitFirs, _options$represent, _options$representTag;
      return {
        tagName,
        nodeKind: "scalar",
        implicit: (_options$implicit = options.implicit) !== null && _options$implicit !== void 0 ? _options$implicit : false,
        matchByTagPrefix: (_options$matchByTagPr = options.matchByTagPrefix) !== null && _options$matchByTagPr !== void 0 ? _options$matchByTagPr : false,
        implicitFirstChars: (_options$implicitFirs = options.implicitFirstChars) !== null && _options$implicitFirs !== void 0 ? _options$implicitFirs : null,
        resolve: options.resolve,
        identify: options.identify,
        represent: (_options$represent = options.represent) !== null && _options$represent !== void 0 ? _options$represent : ((data) => String(data)),
        representTagName: (_options$representTag = options.representTagName) !== null && _options$representTag !== void 0 ? _options$representTag : (() => tagName)
      };
    }
    function defineSequenceTag(tagName, options) {
      var _options$matchByTagPr2, _options$finalize, _options$represent2, _options$representTag2;
      const carrierIsResult = options.finalize === void 0;
      return {
        tagName,
        nodeKind: "sequence",
        implicit: false,
        matchByTagPrefix: (_options$matchByTagPr2 = options.matchByTagPrefix) !== null && _options$matchByTagPr2 !== void 0 ? _options$matchByTagPr2 : false,
        create: options.create,
        addItem: options.addItem,
        finalize: (_options$finalize = options.finalize) !== null && _options$finalize !== void 0 ? _options$finalize : ((carrier) => carrier),
        carrierIsResult,
        identify: options.identify,
        represent: (_options$represent2 = options.represent) !== null && _options$represent2 !== void 0 ? _options$represent2 : ((data) => data),
        representTagName: (_options$representTag2 = options.representTagName) !== null && _options$representTag2 !== void 0 ? _options$representTag2 : (() => tagName)
      };
    }
    function defineMappingTag(tagName, options) {
      var _options$matchByTagPr3, _options$finalize2, _options$represent3, _options$representTag3;
      const carrierIsResult = options.finalize === void 0;
      return {
        tagName,
        nodeKind: "mapping",
        implicit: false,
        matchByTagPrefix: (_options$matchByTagPr3 = options.matchByTagPrefix) !== null && _options$matchByTagPr3 !== void 0 ? _options$matchByTagPr3 : false,
        create: options.create,
        addPair: options.addPair,
        has: options.has,
        keys: options.keys,
        get: options.get,
        finalize: (_options$finalize2 = options.finalize) !== null && _options$finalize2 !== void 0 ? _options$finalize2 : ((carrier) => carrier),
        carrierIsResult,
        identify: options.identify,
        represent: (_options$represent3 = options.represent) !== null && _options$represent3 !== void 0 ? _options$represent3 : ((data) => data),
        representTagName: (_options$representTag3 = options.representTagName) !== null && _options$representTag3 !== void 0 ? _options$representTag3 : (() => tagName)
      };
    }
    var strTag = defineScalarTag("tag:yaml.org,2002:str", {
      resolve: (source) => source,
      identify: (data) => typeof data === "string"
    });
    var NULL_VALUES$1 = [
      "",
      "~",
      "null",
      "Null",
      "NULL"
    ];
    var nullCoreTag = defineScalarTag("tag:yaml.org,2002:null", {
      implicit: true,
      implicitFirstChars: [
        "",
        "~",
        "n",
        "N"
      ],
      resolve: (source) => {
        if (NULL_VALUES$1.indexOf(source) !== -1) return null;
        return NOT_RESOLVED;
      },
      identify: (object) => object === null,
      represent: () => "null"
    });
    var nullJsonTag = defineScalarTag("tag:yaml.org,2002:null", {
      implicit: true,
      implicitFirstChars: ["n"],
      resolve: (source, isExplicit) => {
        if (source === "null" || isExplicit && source === "") return null;
        return NOT_RESOLVED;
      },
      identify: (object) => object === null,
      represent: () => "null"
    });
    var NULL_VALUES = [
      "",
      "~",
      "null",
      "Null",
      "NULL"
    ];
    var nullYaml11Tag = defineScalarTag("tag:yaml.org,2002:null", {
      implicit: true,
      implicitFirstChars: [
        "",
        "~",
        "n",
        "N"
      ],
      resolve: (source) => {
        if (NULL_VALUES.indexOf(source) !== -1) return null;
        return NOT_RESOLVED;
      },
      identify: (object) => object === null,
      represent: () => "null"
    });
    var TRUE_VALUES$2 = [
      "true",
      "True",
      "TRUE"
    ];
    var FALSE_VALUES$2 = [
      "false",
      "False",
      "FALSE"
    ];
    var boolCoreTag = defineScalarTag("tag:yaml.org,2002:bool", {
      implicit: true,
      implicitFirstChars: [
        "t",
        "T",
        "f",
        "F"
      ],
      resolve: (source) => {
        if (TRUE_VALUES$2.indexOf(source) !== -1) return true;
        if (FALSE_VALUES$2.indexOf(source) !== -1) return false;
        return NOT_RESOLVED;
      },
      identify: (object) => Object.prototype.toString.call(object) === "[object Boolean]",
      represent: (object) => object ? "true" : "false"
    });
    var TRUE_VALUES$1 = ["true"];
    var FALSE_VALUES$1 = ["false"];
    var boolJsonTag = defineScalarTag("tag:yaml.org,2002:bool", {
      implicit: true,
      implicitFirstChars: ["t", "f"],
      resolve: (source) => {
        if (TRUE_VALUES$1.indexOf(source) !== -1) return true;
        if (FALSE_VALUES$1.indexOf(source) !== -1) return false;
        return NOT_RESOLVED;
      },
      identify: (object) => Object.prototype.toString.call(object) === "[object Boolean]",
      represent: (object) => object ? "true" : "false"
    });
    var TRUE_VALUES = [
      "true",
      "True",
      "TRUE",
      "y",
      "Y",
      "yes",
      "Yes",
      "YES",
      "on",
      "On",
      "ON"
    ];
    var FALSE_VALUES = [
      "false",
      "False",
      "FALSE",
      "n",
      "N",
      "no",
      "No",
      "NO",
      "off",
      "Off",
      "OFF"
    ];
    var boolYaml11Tag = defineScalarTag("tag:yaml.org,2002:bool", {
      implicit: true,
      implicitFirstChars: [
        "y",
        "Y",
        "n",
        "N",
        "t",
        "T",
        "f",
        "F",
        "o",
        "O"
      ],
      resolve: (source) => {
        if (TRUE_VALUES.indexOf(source) !== -1) return true;
        if (FALSE_VALUES.indexOf(source) !== -1) return false;
        return NOT_RESOLVED;
      },
      identify: (object) => Object.prototype.toString.call(object) === "[object Boolean]",
      represent: (object) => object ? "true" : "false"
    });
    var YAML_INTEGER_IMPLICIT_PATTERN$1 = /* @__PURE__ */ new RegExp("^(?:0o[0-7]+|0x[0-9a-fA-F]+|[-+]?[0-9]+)$");
    var YAML_INTEGER_EXPLICIT_PATTERN$1 = /* @__PURE__ */ new RegExp("^(?:[-+]?0b[0-1]+|[-+]?0o[0-7]+|[-+]?0x[0-9a-fA-F]+|[-+]?[0-9]+)$");
    function parseYamlInteger$2(source) {
      let value = source;
      let sign = 1;
      if (value[0] === "-" || value[0] === "+") {
        if (value[0] === "-") sign = -1;
        value = value.slice(1);
      }
      if (value.startsWith("0b")) return sign * parseInt(value.slice(2), 2);
      if (value.startsWith("0o")) return sign * parseInt(value.slice(2), 8);
      if (value.startsWith("0x")) return sign * parseInt(value.slice(2), 16);
      return sign * parseInt(value, 10);
    }
    function resolveYamlInteger$2(source, isExplicit) {
      if (isExplicit) {
        if (!YAML_INTEGER_EXPLICIT_PATTERN$1.test(source)) return NOT_RESOLVED;
      } else if (!YAML_INTEGER_IMPLICIT_PATTERN$1.test(source)) return NOT_RESOLVED;
      const result = parseYamlInteger$2(source);
      return Number.isFinite(result) ? result : NOT_RESOLVED;
    }
    var intCoreTag = defineScalarTag("tag:yaml.org,2002:int", {
      implicit: true,
      implicitFirstChars: [
        "-",
        "+",
        ..."0123456789"
      ],
      resolve: resolveYamlInteger$2,
      identify: (object) => Number.isInteger(object) && !Object.is(object, -0) && object.toString(10).indexOf("e") < 0,
      represent: (object) => object.toString(10)
    });
    var YAML_INTEGER_IMPLICIT_PATTERN = /* @__PURE__ */ new RegExp("^-?(?:0|[1-9][0-9]*)$");
    var YAML_INTEGER_EXPLICIT_PATTERN = /* @__PURE__ */ new RegExp("^(?:[-+]?0b[0-1]+|[-+]?0o[0-7]+|[-+]?0x[0-9a-fA-F]+|[-+]?[0-9]+)$");
    function parseYamlInteger$1(source) {
      let value = source;
      let sign = 1;
      if (value[0] === "-" || value[0] === "+") {
        if (value[0] === "-") sign = -1;
        value = value.slice(1);
      }
      if (value.startsWith("0b")) return sign * parseInt(value.slice(2), 2);
      if (value.startsWith("0o")) return sign * parseInt(value.slice(2), 8);
      if (value.startsWith("0x")) return sign * parseInt(value.slice(2), 16);
      return sign * parseInt(value, 10);
    }
    function resolveYamlInteger$1(source, isExplicit) {
      if (isExplicit) {
        if (!YAML_INTEGER_EXPLICIT_PATTERN.test(source)) return NOT_RESOLVED;
      } else if (!YAML_INTEGER_IMPLICIT_PATTERN.test(source)) return NOT_RESOLVED;
      const result = parseYamlInteger$1(source);
      return Number.isFinite(result) ? result : NOT_RESOLVED;
    }
    var intJsonTag = defineScalarTag("tag:yaml.org,2002:int", {
      implicit: true,
      implicitFirstChars: ["-", ..."0123456789"],
      resolve: resolveYamlInteger$1,
      identify: (object) => Number.isInteger(object) && !Object.is(object, -0) && object.toString(10).indexOf("e") < 0,
      represent: (object) => object.toString(10)
    });
    var YAML_INTEGER_PATTERN = /* @__PURE__ */ new RegExp("^(?:[-+]?0b[0-1_]+|[-+]?0[0-7_]+|[-+]?0x[0-9a-fA-F_]+|[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+|[-+]?(?:0|[1-9][0-9_]*))$");
    function parseYamlInteger(source) {
      let value = source.replace(/_/g, "");
      let sign = 1;
      if (value[0] === "-" || value[0] === "+") {
        if (value[0] === "-") sign = -1;
        value = value.slice(1);
      }
      if (value.startsWith("0b")) return sign * parseInt(value.slice(2), 2);
      if (value.startsWith("0x")) return sign * parseInt(value.slice(2), 16);
      if (value.includes(":")) {
        let result = 0;
        for (const part of value.split(":")) result = result * 60 + Number(part);
        return sign * result;
      }
      if (value !== "0" && value[0] === "0") return sign * parseInt(value, 8);
      return sign * parseInt(value, 10);
    }
    function resolveYamlInteger(source) {
      if (!YAML_INTEGER_PATTERN.test(source)) return NOT_RESOLVED;
      const result = parseYamlInteger(source);
      return Number.isFinite(result) ? result : NOT_RESOLVED;
    }
    var intYaml11Tag = defineScalarTag("tag:yaml.org,2002:int", {
      implicit: true,
      implicitFirstChars: [
        "-",
        "+",
        ..."0123456789"
      ],
      resolve: resolveYamlInteger,
      identify: (object) => Number.isInteger(object) && !Object.is(object, -0) && object.toString(10).indexOf("e") < 0,
      represent: (object) => object.toString(10)
    });
    var YAML_FLOAT_PATTERN$1 = /* @__PURE__ */ new RegExp("^(?:[-+]?[0-9]+(?:\\.[0-9]*)?(?:[eE][-+]?[0-9]+)?|[-+]?\\.[0-9]+(?:[eE][-+]?[0-9]+)?|[-+]?\\.(?:inf|Inf|INF)|\\.(?:nan|NaN|NAN))$");
    var YAML_FLOAT_SPECIAL_PATTERN$1 = /* @__PURE__ */ new RegExp("^(?:[-+]?\\.(?:inf|Inf|INF)|\\.(?:nan|NaN|NAN))$");
    function resolveYamlFloat$2(source) {
      if (!YAML_FLOAT_PATTERN$1.test(source)) return NOT_RESOLVED;
      let value = source.toLowerCase();
      const sign = value[0] === "-" ? -1 : 1;
      if ("+-".includes(value[0])) value = value.slice(1);
      if (value === ".inf") return sign === 1 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
      if (value === ".nan") return NaN;
      const result = sign * parseFloat(value);
      if (Number.isFinite(result) || YAML_FLOAT_SPECIAL_PATTERN$1.test(source)) return result;
      return NOT_RESOLVED;
    }
    function representYamlFloat$2(object) {
      if (isNaN(object)) return ".nan";
      if (object === Number.POSITIVE_INFINITY) return ".inf";
      if (object === Number.NEGATIVE_INFINITY) return "-.inf";
      if (Object.is(object, -0)) return "-0.0";
      const result = object.toString(10);
      return /^[-+]?[0-9]+e/.test(result) ? result.replace("e", ".e") : result;
    }
    var floatCoreTag = defineScalarTag("tag:yaml.org,2002:float", {
      implicit: true,
      implicitFirstChars: [
        "-",
        "+",
        ".",
        ..."0123456789"
      ],
      resolve: resolveYamlFloat$2,
      identify: (object) => typeof object === "number" && (!Number.isInteger(object) || Object.is(object, -0) || object.toString(10).indexOf("e") >= 0),
      represent: representYamlFloat$2
    });
    var YAML_FLOAT_IMPLICIT_PATTERN = /* @__PURE__ */ new RegExp("^-?(?:0|[1-9][0-9]*)(?:\\.[0-9]*)?(?:[eE][-+]?[0-9]+)?$");
    var YAML_FLOAT_EXPLICIT_PATTERN = /* @__PURE__ */ new RegExp("^(?:[-+]?[0-9]+(?:\\.[0-9]*)?(?:[eE][-+]?[0-9]+)?|[-+]?\\.[0-9]+(?:[eE][-+]?[0-9]+)?|[-+]?\\.(?:inf|Inf|INF)|\\.(?:nan|NaN|NAN))$");
    function resolveYamlFloat$1(source, isExplicit) {
      if (isExplicit) {
        if (!YAML_FLOAT_EXPLICIT_PATTERN.test(source)) return NOT_RESOLVED;
        let value = source.toLowerCase();
        const sign = value[0] === "-" ? -1 : 1;
        if ("+-".includes(value[0])) value = value.slice(1);
        if (value === ".inf") return sign === 1 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
        if (value === ".nan") return NaN;
        const result2 = sign * parseFloat(value);
        return Number.isFinite(result2) ? result2 : NOT_RESOLVED;
      }
      if (!YAML_FLOAT_IMPLICIT_PATTERN.test(source)) return NOT_RESOLVED;
      const result = Number(source);
      if (Number.isFinite(result)) return result;
      return NOT_RESOLVED;
    }
    function representYamlFloat$1(object) {
      if (isNaN(object)) return ".nan";
      if (object === Number.POSITIVE_INFINITY) return ".inf";
      if (object === Number.NEGATIVE_INFINITY) return "-.inf";
      if (Object.is(object, -0)) return "-0.0";
      const result = object.toString(10);
      return /^[-+]?[0-9]+e/.test(result) ? result.replace("e", ".e") : result;
    }
    var floatJsonTag = defineScalarTag("tag:yaml.org,2002:float", {
      implicit: true,
      implicitFirstChars: ["-", ..."0123456789"],
      resolve: resolveYamlFloat$1,
      identify: (object) => typeof object === "number" && (!Number.isInteger(object) || Object.is(object, -0) || object.toString(10).indexOf("e") >= 0),
      represent: representYamlFloat$1
    });
    var YAML_FLOAT_PATTERN = /* @__PURE__ */ new RegExp("^(?:[-+]?(?:(?:[0-9][0-9_]*)?\\.[0-9_]*)(?:[eE][-+][0-9]+)?|[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\\.[0-9_]*|[-+]?\\.(?:inf|Inf|INF)|\\.(?:nan|NaN|NAN))$");
    var YAML_FLOAT_SPECIAL_PATTERN = /* @__PURE__ */ new RegExp("^(?:[-+]?\\.(?:inf|Inf|INF)|\\.(?:nan|NaN|NAN))$");
    function resolveYamlFloat(source) {
      if (!YAML_FLOAT_PATTERN.test(source)) return NOT_RESOLVED;
      let value = source.toLowerCase().replace(/_/g, "");
      const sign = value[0] === "-" ? -1 : 1;
      if ("+-".includes(value[0])) value = value.slice(1);
      if (value === ".inf") return sign === 1 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
      if (value === ".nan") return NaN;
      let result = 0;
      if (value.includes(":")) {
        for (const part of value.split(":")) result = result * 60 + Number(part);
        result *= sign;
      } else result = sign * parseFloat(value);
      if (Number.isFinite(result) || YAML_FLOAT_SPECIAL_PATTERN.test(source)) return result;
      return NOT_RESOLVED;
    }
    function representYamlFloat(object) {
      if (isNaN(object)) return ".nan";
      if (object === Number.POSITIVE_INFINITY) return ".inf";
      if (object === Number.NEGATIVE_INFINITY) return "-.inf";
      if (Object.is(object, -0)) return "-0.0";
      const result = object.toString(10);
      return /^[-+]?[0-9]+e/.test(result) ? result.replace("e", ".e") : result;
    }
    var floatYaml11Tag = defineScalarTag("tag:yaml.org,2002:float", {
      implicit: true,
      implicitFirstChars: [
        "-",
        "+",
        ".",
        ..."0123456789"
      ],
      resolve: resolveYamlFloat,
      identify: (object) => typeof object === "number" && (!Number.isInteger(object) || Object.is(object, -0) || object.toString(10).indexOf("e") >= 0),
      represent: representYamlFloat
    });
    var mergeTag = defineScalarTag("tag:yaml.org,2002:merge", {
      implicit: true,
      implicitFirstChars: ["<"],
      resolve: (source, isExplicit) => {
        if (source === "<<" || isExplicit && source === "") return "<<";
        return NOT_RESOLVED;
      },
      identify: () => false
    });
    var BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;
    function resolveYamlBinary(source) {
      const input = source.replace(/\s/g, "");
      if (input.length % 4 !== 0 || !BASE64_PATTERN.test(input)) return NOT_RESOLVED;
      const binary = atob(input);
      const result = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index++) result[index] = binary.charCodeAt(index);
      return result;
    }
    function representYamlBinary(object) {
      let binary = "";
      for (let index = 0; index < object.length; index++) binary += String.fromCharCode(object[index]);
      return btoa(binary);
    }
    var binaryTag = defineScalarTag("tag:yaml.org,2002:binary", {
      resolve: resolveYamlBinary,
      identify: (object) => Object.prototype.toString.call(object) === "[object Uint8Array]",
      represent: representYamlBinary
    });
    var YAML_DATE_REGEXP = /* @__PURE__ */ new RegExp("^([0-9][0-9][0-9][0-9])-([0-9][0-9])-([0-9][0-9])$");
    var YAML_TIMESTAMP_REGEXP = /* @__PURE__ */ new RegExp("^([0-9][0-9][0-9][0-9])-([0-9][0-9]?)-([0-9][0-9]?)(?:[Tt]|[ \\t]+)([0-9][0-9]?):([0-9][0-9]):([0-9][0-9])(?:\\.([0-9]*))?(?:[ \\t]*(Z|([-+])([0-9][0-9]?)(?::([0-9][0-9]))?))?$");
    function makeUtcDate(year, month, day, hour = 0, minute = 0, second = 0, fraction = 0) {
      const date = new Date(Date.UTC(year, month, day, hour, minute, second, fraction));
      date.setUTCFullYear(year, month, day);
      return date;
    }
    function resolveYamlTimestamp(source) {
      let match = YAML_DATE_REGEXP.exec(source);
      if (match === null) match = YAML_TIMESTAMP_REGEXP.exec(source);
      if (match === null) return NOT_RESOLVED;
      const year = +match[1];
      const month = +match[2] - 1;
      const day = +match[3];
      if (!match[4]) {
        const date2 = makeUtcDate(year, month, day);
        if (date2.getUTCFullYear() !== year || date2.getUTCMonth() !== month || date2.getUTCDate() !== day) return NOT_RESOLVED;
        return date2;
      }
      const hour = +match[4];
      const minute = +match[5];
      const second = +match[6];
      let fraction = 0;
      if (hour > 23 || minute > 59 || second > 59) return NOT_RESOLVED;
      if (match[7]) {
        let value = match[7].slice(0, 3);
        while (value.length < 3) value += "0";
        fraction = +value;
      }
      const date = makeUtcDate(year, month, day, hour, minute, second, fraction);
      if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day) return NOT_RESOLVED;
      if (match[9]) {
        const offsetHour = +match[10];
        const offsetMinute = +(match[11] || 0);
        if (offsetHour > 23 || offsetMinute > 59) return NOT_RESOLVED;
        const offset = (offsetHour * 60 + offsetMinute) * 6e4;
        date.setTime(date.getTime() - (match[9] === "-" ? -offset : offset));
      }
      return date;
    }
    var timestampTag = defineScalarTag("tag:yaml.org,2002:timestamp", {
      implicit: true,
      implicitFirstChars: [..."0123456789"],
      resolve: resolveYamlTimestamp,
      identify: (object) => object instanceof Date,
      represent: (object) => object.toISOString()
    });
    var seqTag = defineSequenceTag("tag:yaml.org,2002:seq", {
      create: () => [],
      addItem: (container, item) => {
        container.push(item);
      },
      identify: Array.isArray
    });
    function isPlainObject(data) {
      if (data === null || typeof data !== "object" || Array.isArray(data)) return false;
      const prototype = Object.getPrototypeOf(data);
      return prototype === null || prototype === Object.prototype;
    }
    function pick(object, keys) {
      const result = {};
      for (const key of keys) if (object[key] !== void 0) result[key] = object[key];
      return result;
    }
    var omapTag = defineSequenceTag("tag:yaml.org,2002:omap", {
      create: () => ({
        list: [],
        seen: /* @__PURE__ */ new Set()
      }),
      addItem: (carrier, item) => {
        let key;
        if (item instanceof Map) {
          if (item.size !== 1) return "cannot resolve an ordered map item";
          key = item.keys().next().value;
        } else if (isPlainObject(item)) {
          const itemKeys = Object.keys(item);
          if (itemKeys.length !== 1) return "cannot resolve an ordered map item";
          key = itemKeys[0];
        } else return "cannot resolve an ordered map item";
        if (carrier.seen.has(key)) return "duplicate key in ordered map";
        carrier.seen.add(key);
        carrier.list.push(item);
        return "";
      },
      finalize: (carrier) => carrier.list,
      identify: () => false
    });
    var pairsTag = defineSequenceTag("tag:yaml.org,2002:pairs", {
      create: () => [],
      addItem: (container, item) => {
        if (item instanceof Map) {
          if (item.size !== 1) return "cannot resolve a pairs item";
          container.push(item.entries().next().value);
          return "";
        }
        if (Object.prototype.toString.call(item) !== "[object Object]") return "cannot resolve a pairs item";
        const object = item;
        const keys = Object.keys(object);
        if (keys.length !== 1) return "cannot resolve a pairs item";
        container.push([keys[0], object[keys[0]]]);
        return "";
      },
      identify: () => false
    });
    var mapTag = defineMappingTag("tag:yaml.org,2002:map", {
      create: () => ({}),
      identify: isPlainObject,
      represent: (o) => {
        const map = /* @__PURE__ */ new Map();
        for (const key of Object.keys(o)) map.set(key, o[key]);
        return map;
      },
      addPair: (container, key, value) => {
        if (key !== null && typeof key === "object") return "object-based map does not support complex keys";
        const normalizedKey = String(key);
        if (normalizedKey === "__proto__") Object.defineProperty(container, normalizedKey, {
          value,
          enumerable: true,
          configurable: true,
          writable: true
        });
        else container[normalizedKey] = value;
        return "";
      },
      has: (container, key) => {
        if (key !== null && typeof key === "object") return false;
        return Object.prototype.hasOwnProperty.call(container, String(key));
      },
      keys: (container) => Object.keys(container),
      get: (container, key) => {
        const normalizedKey = String(key);
        if (!Object.prototype.hasOwnProperty.call(container, normalizedKey)) return null;
        return container[normalizedKey];
      }
    });
    var setTag = defineMappingTag("tag:yaml.org,2002:set", {
      create: () => /* @__PURE__ */ new Set(),
      identify: (data) => data instanceof Set,
      represent: (data) => {
        const map = /* @__PURE__ */ new Map();
        for (const key of data) map.set(key, null);
        return map;
      },
      addPair: (container, key, value) => {
        if (value !== null) return "cannot resolve a set item";
        container.add(key);
        return "";
      },
      has: (container, key) => container.has(key),
      keys: (container) => container.keys(),
      get: () => null
    });
    function _typeof(o) {
      "@babel/helpers - typeof";
      return _typeof = "function" == typeof Symbol && "symbol" == typeof Symbol.iterator ? function(o2) {
        return typeof o2;
      } : function(o2) {
        return o2 && "function" == typeof Symbol && o2.constructor === Symbol && o2 !== Symbol.prototype ? "symbol" : typeof o2;
      }, _typeof(o);
    }
    function toPrimitive(t, r) {
      if ("object" != _typeof(t) || !t) return t;
      var e = t[Symbol.toPrimitive];
      if (void 0 !== e) {
        var i = e.call(t, r || "default");
        if ("object" != _typeof(i)) return i;
        throw new TypeError("@@toPrimitive must return a primitive value.");
      }
      return ("string" === r ? String : Number)(t);
    }
    function toPropertyKey(t) {
      var i = toPrimitive(t, "string");
      return "symbol" == _typeof(i) ? i : i + "";
    }
    function _defineProperty(e, r, t) {
      return (r = toPropertyKey(r)) in e ? Object.defineProperty(e, r, {
        value: t,
        enumerable: true,
        configurable: true,
        writable: true
      }) : e[r] = t, e;
    }
    function ownKeys(e, r) {
      var t = Object.keys(e);
      if (Object.getOwnPropertySymbols) {
        var o = Object.getOwnPropertySymbols(e);
        r && (o = o.filter(function(r2) {
          return Object.getOwnPropertyDescriptor(e, r2).enumerable;
        })), t.push.apply(t, o);
      }
      return t;
    }
    function _objectSpread2(e) {
      for (var r = 1; r < arguments.length; r++) {
        var t = null != arguments[r] ? arguments[r] : {};
        r % 2 ? ownKeys(Object(t), true).forEach(function(r2) {
          _defineProperty(e, r2, t[r2]);
        }) : Object.getOwnPropertyDescriptors ? Object.defineProperties(e, Object.getOwnPropertyDescriptors(t)) : ownKeys(Object(t)).forEach(function(r2) {
          Object.defineProperty(e, r2, Object.getOwnPropertyDescriptor(t, r2));
        });
      }
      return e;
    }
    function createTagDefinitionMap() {
      return {
        scalar: /* @__PURE__ */ Object.create(null),
        sequence: /* @__PURE__ */ Object.create(null),
        mapping: /* @__PURE__ */ Object.create(null)
      };
    }
    function createTagDefinitionListMap() {
      return {
        scalar: [],
        sequence: [],
        mapping: []
      };
    }
    function compileTags(tags) {
      const result = [];
      for (const tag of tags) {
        let index = result.length;
        for (let previousIndex = 0; previousIndex < result.length; previousIndex++) {
          const previous = result[previousIndex];
          if (previous.nodeKind === tag.nodeKind && previous.tagName === tag.tagName && previous.matchByTagPrefix === tag.matchByTagPrefix) {
            index = previousIndex;
            break;
          }
        }
        result[index] = tag;
      }
      return result;
    }
    var Schema = class Schema2 {
      constructor(tags) {
        _defineProperty(this, "tags", void 0);
        _defineProperty(
          this,
          /** @internal */
          "implicitScalarTags",
          void 0
        );
        _defineProperty(
          this,
          /**
          * Dispatch implicit scalar resolvers by `source.charAt(0)`. Each bucket holds
          * the resolvers that may match that key, in schema order; a key absent from
          * the map uses
          * {@link Schema.implicitScalarAnyFirstChar}
          * (resolvers that declared no first-char constraint, so they apply to any
          * first character).
          */
          "implicitScalarByFirstChar",
          void 0
        );
        _defineProperty(this, "implicitScalarAnyFirstChar", void 0);
        _defineProperty(
          this,
          /**
          * The default scalar tag (`!!str`), resolved once so the composer's fallback
          * for unresolved plain scalars avoids a keyed lookup per scalar.
          *
          * @internal
          */
          "defaultScalarTag",
          void 0
        );
        _defineProperty(
          this,
          /**
          * The default container tags (`!!seq` / `!!map`), used by the dumper: when a
          * value is identified by its default tag, the tag is implicit and not
          * printed. Undefined if the schema does not define them (then such values
          * can't be dumped).
          *
          * @internal
          */
          "defaultSequenceTag",
          void 0
        );
        _defineProperty(
          this,
          /** @internal */
          "defaultMappingTag",
          void 0
        );
        _defineProperty(this, "exact", void 0);
        _defineProperty(this, "prefix", void 0);
        const compiledTags = compileTags(tags);
        const implicitScalarTags = [];
        const exact = createTagDefinitionMap();
        const prefix = createTagDefinitionListMap();
        for (const tag of compiledTags) {
          if (tag.nodeKind === "scalar" && tag.implicit) {
            if (tag.matchByTagPrefix) throw new Error("Implicit scalar tags cannot match by tag prefix");
            implicitScalarTags.push(tag);
          }
          switch (tag.nodeKind) {
            case "scalar":
              if (tag.matchByTagPrefix) prefix.scalar.push(tag);
              else exact.scalar[tag.tagName] = tag;
              break;
            case "sequence":
              if (tag.matchByTagPrefix) prefix.sequence.push(tag);
              else exact.sequence[tag.tagName] = tag;
              break;
            case "mapping":
              if (tag.matchByTagPrefix) prefix.mapping.push(tag);
              else exact.mapping[tag.tagName] = tag;
              break;
          }
        }
        const implicitScalarAnyFirstChar = implicitScalarTags.filter((tag) => tag.implicitFirstChars === null);
        const keys = /* @__PURE__ */ new Set();
        for (const tag of implicitScalarTags) if (tag.implicitFirstChars !== null) for (const key of tag.implicitFirstChars) keys.add(key);
        const implicitScalarByFirstChar = /* @__PURE__ */ new Map();
        for (const key of keys) implicitScalarByFirstChar.set(key, implicitScalarTags.filter((tag) => tag.implicitFirstChars === null || tag.implicitFirstChars.indexOf(key) !== -1));
        const defaultScalarTag = exact.scalar["tag:yaml.org,2002:str"];
        if (!defaultScalarTag) throw new Error("schema does not define the default scalar tag (tag:yaml.org,2002:str)");
        this.tags = compiledTags;
        this.implicitScalarTags = implicitScalarTags;
        this.implicitScalarByFirstChar = implicitScalarByFirstChar;
        this.implicitScalarAnyFirstChar = implicitScalarAnyFirstChar;
        this.defaultScalarTag = defaultScalarTag;
        this.defaultSequenceTag = exact.sequence["tag:yaml.org,2002:seq"];
        this.defaultMappingTag = exact.mapping["tag:yaml.org,2002:map"];
        this.exact = exact;
        this.prefix = prefix;
      }
      /** @internal */
      lookupScalarTag(tagName) {
        const exactTag = this.exact.scalar[tagName];
        if (exactTag) return exactTag;
        for (const tag of this.prefix.scalar) if (tagName.startsWith(tag.tagName)) return tag;
      }
      /** @internal */
      lookupSequenceTag(tagName) {
        const exactTag = this.exact.sequence[tagName];
        if (exactTag) return exactTag;
        for (const tag of this.prefix.sequence) if (tagName.startsWith(tag.tagName)) return tag;
      }
      /** @internal */
      lookupMappingTag(tagName) {
        const exactTag = this.exact.mapping[tagName];
        if (exactTag) return exactTag;
        for (const tag of this.prefix.mapping) if (tagName.startsWith(tag.tagName)) return tag;
      }
      /** @internal */
      resolveImplicitScalarTag(source) {
        var _this$implicitScalarB;
        const candidates = (_this$implicitScalarB = this.implicitScalarByFirstChar.get(source.charAt(0))) !== null && _this$implicitScalarB !== void 0 ? _this$implicitScalarB : this.implicitScalarAnyFirstChar;
        for (const tag2 of candidates) {
          const value = tag2.resolve(source, false, tag2.tagName);
          if (value !== NOT_RESOLVED) return {
            value,
            tag: tag2
          };
        }
        const tag = this.defaultScalarTag;
        return {
          value: tag.resolve(source, false, tag.tagName),
          tag
        };
      }
      /**
      * Creates a new schema with the specified tags added. If a tag already
      * exists, it is replaced by the specified tag.
      *
      * @example
      *
      * ```javascript
      * import { CORE_SCHEMA, mergeTag, realMapTag } from 'js-yaml'
      *
      * const schema = CORE_SCHEMA.withTags(mergeTag, realMapTag)
      * ```
      */
      withTags(...tags) {
        let flatTags = [];
        for (const tag of tags) flatTags = flatTags.concat(tag);
        return new Schema2([...this.tags, ...flatTags]);
      }
    };
    var FAILSAFE_SCHEMA = new Schema([
      strTag,
      seqTag,
      mapTag
    ]);
    var JSON_SCHEMA = new Schema([
      ...FAILSAFE_SCHEMA.tags,
      nullJsonTag,
      boolJsonTag,
      intJsonTag,
      floatJsonTag
    ]);
    var CORE_SCHEMA = new Schema([
      ...FAILSAFE_SCHEMA.tags,
      nullCoreTag,
      boolCoreTag,
      intCoreTag,
      floatCoreTag
    ]);
    var YAML11_SCHEMA = new Schema([
      ...FAILSAFE_SCHEMA.tags,
      nullYaml11Tag,
      boolYaml11Tag,
      intYaml11Tag,
      floatYaml11Tag,
      timestampTag,
      mergeTag,
      binaryTag,
      omapTag,
      pairsTag,
      setTag
    ]);
    var DUMP_SCHEMA = YAML11_SCHEMA.withTags(_objectSpread2(_objectSpread2({}, intYaml11Tag), {}, { resolve: (source, isExplicit, tagName) => {
      const result = intYaml11Tag.resolve(source, isExplicit, tagName);
      return result === NOT_RESOLVED ? intCoreTag.resolve(source, isExplicit, tagName) : result;
    } }), _objectSpread2(_objectSpread2({}, floatYaml11Tag), {}, { resolve: (source, isExplicit, tagName) => {
      const result = floatYaml11Tag.resolve(source, isExplicit, tagName);
      return result === NOT_RESOLVED ? floatCoreTag.resolve(source, isExplicit, tagName) : result;
    } }));
    var realMapTag = defineMappingTag("tag:yaml.org,2002:map", {
      create: () => /* @__PURE__ */ new Map(),
      addPair: (container, key, value) => {
        container.set(key, value);
        return "";
      },
      has: (container, key) => container.has(key),
      keys: (container) => container.keys(),
      get: (container, key) => container.get(key),
      identify: (data) => data instanceof Map || isPlainObject(data),
      represent: (data) => {
        if (data instanceof Map) return data;
        const map = /* @__PURE__ */ new Map();
        const obj = data;
        for (const key of Object.keys(obj)) map.set(key, obj[key]);
        return map;
      }
    });
    function normalizeKey(key) {
      if (Array.isArray(key)) {
        const array = Array.prototype.slice.call(key);
        for (let index = 0; index < array.length; index++) {
          if (Array.isArray(array[index])) return null;
          if (typeof array[index] === "object" && Object.prototype.toString.call(array[index]) === "[object Object]") array[index] = "[object Object]";
        }
        return String(array);
      }
      if (typeof key === "object" && Object.prototype.toString.call(key) === "[object Object]") return "[object Object]";
      return String(key);
    }
    var legacyMapTag = defineMappingTag("tag:yaml.org,2002:map", {
      create: () => ({}),
      identify: isPlainObject,
      represent: (o) => {
        const map = /* @__PURE__ */ new Map();
        for (const key of Object.keys(o)) map.set(key, o[key]);
        return map;
      },
      addPair: (container, key, value) => {
        const normalizedKey = normalizeKey(key);
        if (normalizedKey === null) return "nested arrays are not supported inside keys";
        if (normalizedKey === "__proto__") Object.defineProperty(container, normalizedKey, {
          value,
          enumerable: true,
          configurable: true,
          writable: true
        });
        else container[normalizedKey] = value;
        return "";
      },
      has: (container, key) => {
        const normalizedKey = normalizeKey(key);
        return normalizedKey !== null && Object.prototype.hasOwnProperty.call(container, normalizedKey);
      },
      keys: (container) => Object.keys(container),
      get: (container, key) => {
        const normalizedKey = String(key);
        if (!Object.prototype.hasOwnProperty.call(container, normalizedKey)) return null;
        return container[normalizedKey];
      }
    });
    var DEFAULT_SNIPPET_OPTIONS = {
      maxLength: 79,
      indent: 1,
      linesBefore: 3,
      linesAfter: 2
    };
    function getLine(buffer, lineStart, lineEnd, position, maxLineLength) {
      let head = "";
      let tail = "";
      const maxHalfLength = Math.floor(maxLineLength / 2) - 1;
      if (position - lineStart > maxHalfLength) {
        head = " ... ";
        lineStart = position - maxHalfLength + head.length;
      }
      if (lineEnd - position > maxHalfLength) {
        tail = " ...";
        lineEnd = position + maxHalfLength - tail.length;
      }
      return {
        str: head + buffer.slice(lineStart, lineEnd).replace(/\t/g, "\u2192") + tail,
        pos: position - lineStart + head.length
      };
    }
    function padStart(string, max) {
      return " ".repeat(Math.max(max - string.length, 0)) + string;
    }
    function makeSnippet(mark, options) {
      if (!mark.buffer) return null;
      const opts = _objectSpread2(_objectSpread2({}, DEFAULT_SNIPPET_OPTIONS), options);
      const re = /\r?\n|\r|\0/g;
      const lineStarts = [0];
      const lineEnds = [];
      let match;
      let foundLineNo = -1;
      while (match = re.exec(mark.buffer)) {
        lineEnds.push(match.index);
        lineStarts.push(match.index + match[0].length);
        if (mark.position <= match.index && foundLineNo < 0) foundLineNo = lineStarts.length - 2;
      }
      if (foundLineNo < 0) foundLineNo = lineStarts.length - 1;
      let result = "";
      const lineNoLength = Math.min(mark.line + opts.linesAfter, lineEnds.length).toString().length;
      const maxLineLength = opts.maxLength - (opts.indent + lineNoLength + 3);
      for (let i = 1; i <= opts.linesBefore; i++) {
        if (foundLineNo - i < 0) break;
        const line2 = getLine(mark.buffer, lineStarts[foundLineNo - i], lineEnds[foundLineNo - i], mark.position - (lineStarts[foundLineNo] - lineStarts[foundLineNo - i]), maxLineLength);
        result = `${" ".repeat(opts.indent)}${padStart((mark.line - i + 1).toString(), lineNoLength)} | ${line2.str}
${result}`;
      }
      const line = getLine(mark.buffer, lineStarts[foundLineNo], lineEnds[foundLineNo], mark.position, maxLineLength);
      result += `${" ".repeat(opts.indent)}${padStart((mark.line + 1).toString(), lineNoLength)} | ${line.str}
`;
      result += `${"-".repeat(opts.indent + lineNoLength + 3 + line.pos)}^
`;
      for (let i = 1; i <= opts.linesAfter; i++) {
        if (foundLineNo + i >= lineEnds.length) break;
        const line2 = getLine(mark.buffer, lineStarts[foundLineNo + i], lineEnds[foundLineNo + i], mark.position - (lineStarts[foundLineNo] - lineStarts[foundLineNo + i]), maxLineLength);
        result += `${" ".repeat(opts.indent)}${padStart((mark.line + i + 1).toString(), lineNoLength)} | ${line2.str}
`;
      }
      return result.replace(/\n$/, "");
    }
    function formatError(exception, compact) {
      let where = "";
      if (!exception.mark) return exception.reason;
      if (exception.mark.name) where += `in "${exception.mark.name}" `;
      where += `(${exception.mark.line + 1}:${exception.mark.column + 1})`;
      if (!compact && exception.mark.snippet) where += `

${exception.mark.snippet}`;
      return `${exception.reason} ${where}`;
    }
    var YAMLException = class YAMLException2 extends Error {
      /**
      * Optional `mark` contains source snippet data. Usually, use
      * {@link YAMLException.throwAt} instead of passing it directly.
      */
      constructor(reason, mark) {
        super();
        _defineProperty(this, "reason", void 0);
        _defineProperty(this, "mark", void 0);
        this.name = "YAMLException";
        this.reason = reason;
        this.mark = mark;
        this.message = formatError(this, false);
        if (Error.captureStackTrace) Error.captureStackTrace(this, this.constructor);
      }
      /**
      * Returns the formatted error, omitting the source snippet in compact mode.
      */
      toString(compact) {
        return `${this.name}: ${formatError(this, compact)}`;
      }
      /**
      * Builds a YAMLException with a source snippet and throws it. `source` is
      * the raw input text; `position` is an offset into it.
      */
      static throwAt(source, position, message, filename = "") {
        let line = 0;
        let lineStart = 0;
        for (let index = 0; index < position; index++) {
          const ch = source.charCodeAt(index);
          if (ch === 10) {
            line++;
            lineStart = index + 1;
          } else if (ch === 13) {
            line++;
            if (source.charCodeAt(index + 1) === 10) index++;
            lineStart = index + 1;
          }
        }
        const mark = {
          name: filename,
          buffer: source,
          position,
          line,
          column: position - lineStart
        };
        mark.snippet = makeSnippet(mark);
        throw new YAMLException2(message, mark);
      }
    };
    var EVENT_ID = {
      DOCUMENT: 1,
      SEQUENCE: 2,
      MAPPING: 3,
      SCALAR: 4,
      ALIAS: 5,
      POP: 6
    };
    var SCALAR_STYLE = {
      PLAIN: 1,
      SINGLE_QUOTED: 2,
      DOUBLE_QUOTED: 3,
      LITERAL_BLOCK: 4,
      FOLDED_BLOCK: 5
    };
    var COLLECTION_STYLE = {
      BLOCK: 1,
      FLOW: 2
    };
    var CHOMPING_MODE = {
      CLIP: 1,
      STRIP: 2,
      KEEP: 3
    };
    var NO_RANGE$3 = -1;
    function simpleEscapeSequence(c) {
      switch (c) {
        case 48:
          return "\0";
        case 97:
          return "\x07";
        case 98:
          return "\b";
        case 116:
          return "	";
        case 9:
          return "	";
        case 110:
          return "\n";
        case 118:
          return "\v";
        case 102:
          return "\f";
        case 114:
          return "\r";
        case 101:
          return "\x1B";
        case 32:
          return " ";
        case 34:
          return '"';
        case 47:
          return "/";
        case 92:
          return "\\";
        case 78:
          return "\x85";
        case 95:
          return "\xA0";
        case 76:
          return "\u2028";
        case 80:
          return "\u2029";
        default:
          return "";
      }
    }
    var simpleEscapeCheck = new Array(256);
    var simpleEscapeMap = new Array(256);
    for (let i = 0; i < 256; i++) {
      simpleEscapeCheck[i] = simpleEscapeSequence(i) ? 1 : 0;
      simpleEscapeMap[i] = simpleEscapeSequence(i);
    }
    function charFromCodepoint(c) {
      if (c <= 65535) return String.fromCharCode(c);
      return String.fromCharCode((c - 65536 >> 10) + 55296, (c - 65536 & 1023) + 56320);
    }
    function fromHexCode$1(c) {
      if (c >= 48 && c <= 57) return c - 48;
      return (c | 32) - 97 + 10;
    }
    function escapedHexLen$1(c) {
      if (c === 120) return 2;
      if (c === 117) return 4;
      return 8;
    }
    function skipFoldedBreaks(input, position, end) {
      let breaks = 0;
      while (position < end) {
        const ch = input.charCodeAt(position);
        if (ch === 10) {
          breaks++;
          position++;
        } else if (ch === 13) {
          breaks++;
          position++;
          if (input.charCodeAt(position) === 10) position++;
        } else if (ch === 32 || ch === 9) position++;
        else break;
      }
      return {
        position,
        breaks
      };
    }
    function foldedBreaks(count) {
      if (count === 1) return " ";
      return "\n".repeat(count - 1);
    }
    function getPlainValue(input, start, end) {
      let result = "";
      let position = start;
      let captureStart = start;
      let captureEnd = start;
      while (position < end) {
        const ch = input.charCodeAt(position);
        if (ch === 10 || ch === 13) {
          result += input.slice(captureStart, captureEnd);
          const fold = skipFoldedBreaks(input, position, end);
          result += foldedBreaks(fold.breaks);
          position = captureStart = captureEnd = fold.position;
        } else {
          position++;
          if (ch !== 32 && ch !== 9) captureEnd = position;
        }
      }
      return result + input.slice(captureStart, captureEnd);
    }
    function getSingleQuotedValue(input, start, end) {
      let result = "";
      let position = start;
      let captureStart = start;
      let captureEnd = start;
      while (position < end) {
        const ch = input.charCodeAt(position);
        if (ch === 39) {
          result += input.slice(captureStart, position) + "'";
          position += 2;
          captureStart = captureEnd = position;
        } else if (ch === 10 || ch === 13) {
          result += input.slice(captureStart, captureEnd);
          const fold = skipFoldedBreaks(input, position, end);
          result += foldedBreaks(fold.breaks);
          position = captureStart = captureEnd = fold.position;
        } else {
          position++;
          if (ch !== 32 && ch !== 9) captureEnd = position;
        }
      }
      return result + input.slice(captureStart, end);
    }
    function getDoubleQuotedValue(input, start, end) {
      let result = "";
      let position = start;
      let captureStart = start;
      let captureEnd = start;
      while (position < end) {
        const ch = input.charCodeAt(position);
        if (ch === 92) {
          result += input.slice(captureStart, position);
          position++;
          const escaped = input.charCodeAt(position);
          if (escaped === 10 || escaped === 13) position = skipFoldedBreaks(input, position, end).position;
          else if (escaped < 256 && simpleEscapeCheck[escaped]) {
            result += simpleEscapeMap[escaped];
            position++;
          } else {
            let hexLength = escapedHexLen$1(escaped);
            let hexResult = 0;
            for (; hexLength > 0; hexLength--) {
              position++;
              const digit = fromHexCode$1(input.charCodeAt(position));
              hexResult = (hexResult << 4) + digit;
            }
            result += charFromCodepoint(hexResult);
            position++;
          }
          captureStart = captureEnd = position;
        } else if (ch === 10 || ch === 13) {
          result += input.slice(captureStart, captureEnd);
          const fold = skipFoldedBreaks(input, position, end);
          result += foldedBreaks(fold.breaks);
          position = captureStart = captureEnd = fold.position;
        } else {
          position++;
          if (ch !== 32 && ch !== 9) captureEnd = position;
        }
      }
      return result + input.slice(captureStart, end);
    }
    function getBlockValue(input, start, end, indent, chomping, folded) {
      const textIndent = indent < 0 ? 0 : indent;
      const region = input.slice(start, end).replace(/\r\n?/g, "\n");
      const lines = region === "" ? [] : (region.endsWith("\n") ? region.slice(0, -1) : region).split("\n");
      let result = "";
      let didReadContent = false;
      let emptyLines = 0;
      let atMoreIndented = false;
      for (const line of lines) {
        let column = 0;
        while (column < textIndent && line.charCodeAt(column) === 32) column++;
        if (indent < 0 || column >= line.length) {
          emptyLines++;
          continue;
        }
        const content = line.slice(textIndent);
        const first = content.charCodeAt(0);
        if (folded) if (first === 32 || first === 9) {
          atMoreIndented = true;
          result += "\n".repeat(didReadContent ? 1 + emptyLines : emptyLines);
        } else if (atMoreIndented) {
          atMoreIndented = false;
          result += "\n".repeat(emptyLines + 1);
        } else if (emptyLines === 0) {
          if (didReadContent) result += " ";
        } else result += "\n".repeat(emptyLines);
        else result += "\n".repeat(didReadContent ? 1 + emptyLines : emptyLines);
        result += content;
        didReadContent = true;
        emptyLines = 0;
      }
      if (chomping === CHOMPING_MODE.KEEP) result += "\n".repeat(didReadContent ? 1 + emptyLines : emptyLines);
      else if (chomping !== CHOMPING_MODE.STRIP) {
        if (didReadContent) result += "\n";
      }
      return result;
    }
    function getScalarValue(input, scalar) {
      if (scalar.valueStart === NO_RANGE$3) return "";
      const { valueStart, valueEnd } = scalar;
      if (scalar.fast) return input.slice(valueStart, valueEnd);
      switch (scalar.style) {
        case SCALAR_STYLE.SINGLE_QUOTED:
          return getSingleQuotedValue(input, valueStart, valueEnd);
        case SCALAR_STYLE.DOUBLE_QUOTED:
          return getDoubleQuotedValue(input, valueStart, valueEnd);
        case SCALAR_STYLE.LITERAL_BLOCK:
          return getBlockValue(input, valueStart, valueEnd, scalar.indent, scalar.chomping, false);
        case SCALAR_STYLE.FOLDED_BLOCK:
          return getBlockValue(input, valueStart, valueEnd, scalar.indent, scalar.chomping, true);
        default:
          return getPlainValue(input, valueStart, valueEnd);
      }
    }
    var DEFAULT_TAG_HANDLERS = Object.assign(/* @__PURE__ */ Object.create(null), {
      "!": "!",
      "!!": "tag:yaml.org,2002:"
    });
    function tagPercentEncode(source) {
      return encodeURI(source).replace(/!/g, "%21");
    }
    function tagNameFull(rawTag2, tagHandlers) {
      var _ref, _tagHandlers$handle;
      if (rawTag2.startsWith("!<") && rawTag2.endsWith(">")) return decodeURIComponent(rawTag2.slice(2, -1));
      const handleEnd = rawTag2.indexOf("!", 1);
      const handle = handleEnd === -1 ? "!" : rawTag2.slice(0, handleEnd + 1);
      const prefix = (_ref = (_tagHandlers$handle = tagHandlers === null || tagHandlers === void 0 ? void 0 : tagHandlers[handle]) !== null && _tagHandlers$handle !== void 0 ? _tagHandlers$handle : DEFAULT_TAG_HANDLERS[handle]) !== null && _ref !== void 0 ? _ref : handle;
      return decodeURIComponent(prefix) + decodeURIComponent(rawTag2.slice(handle.length));
    }
    function tagNameShort(fullTag) {
      let tag = fullTag;
      if (tag.charCodeAt(0) === 33) {
        tag = tag.slice(1);
        return `!${tagPercentEncode(tag)}`;
      }
      if (tag.slice(0, 18) === "tag:yaml.org,2002:") return `!!${tagPercentEncode(tag.slice(18))}`;
      return `!<${tagPercentEncode(tag)}>`;
    }
    var NO_RANGE$2 = -1;
    var MERGE_TAG_NAME = "tag:yaml.org,2002:merge";
    var DEFAULT_CONSTRUCTOR_OPTIONS = {
      filename: "",
      schema: CORE_SCHEMA,
      json: false,
      maxTotalMergeKeys: 1e4,
      maxAliases: -1
    };
    function eventPosition$1(event) {
      if ("tagStart" in event && event.tagStart !== NO_RANGE$2) return event.tagStart;
      if ("anchorStart" in event && event.anchorStart !== NO_RANGE$2) return event.anchorStart;
      if ("valueStart" in event && event.valueStart !== NO_RANGE$2) return event.valueStart;
      if ("start" in event) return event.start;
      return 0;
    }
    function throwError$1(state, message) {
      YAMLException.throwAt(state.source, state.position, message, state.filename);
    }
    function finalizeCollection(state, position, tag, carrier) {
      try {
        return tag.finalize(carrier);
      } catch (error) {
        if (error instanceof YAMLException) throw error;
        YAMLException.throwAt(state.source, position, error instanceof Error ? error.message : String(error), state.filename);
      }
    }
    function constructScalar(state, event) {
      const source = getScalarValue(state.source, event);
      const rawTag2 = event.tagStart === NO_RANGE$2 ? "" : state.source.slice(event.tagStart, event.tagEnd);
      const strTag2 = state.schema.defaultScalarTag;
      if (rawTag2 !== "") {
        var _state$schema$lookupM;
        if (rawTag2 === "!") return {
          value: source,
          tag: strTag2
        };
        const tagName = tagNameFull(rawTag2, state.tagHandlers);
        const scalarTag = state.schema.lookupScalarTag(tagName);
        if (scalarTag) {
          const result = scalarTag.resolve(source, true, tagName);
          if (result === NOT_RESOLVED) throwError$1(state, `cannot resolve a node with !<${tagName}> explicit tag`);
          return {
            value: result,
            tag: scalarTag
          };
        }
        const collectionTagDef = (_state$schema$lookupM = state.schema.lookupMappingTag(tagName)) !== null && _state$schema$lookupM !== void 0 ? _state$schema$lookupM : state.schema.lookupSequenceTag(tagName);
        if (collectionTagDef) {
          if (source !== "") throwError$1(state, `cannot resolve a node with !<${tagName}> explicit tag`);
          const carrier = collectionTagDef.create(tagName);
          return {
            value: collectionTagDef.carrierIsResult ? carrier : finalizeCollection(state, state.position, collectionTagDef, carrier),
            tag: collectionTagDef
          };
        }
        throwError$1(state, `unknown scalar tag !<${tagName}>`);
      }
      if (event.style === SCALAR_STYLE.PLAIN) return state.schema.resolveImplicitScalarTag(source);
      return {
        value: strTag2.resolve(source, false, strTag2.tagName),
        tag: strTag2
      };
    }
    function collectionTagName(state, event, defaultTagName) {
      const rawTag2 = event.tagStart === NO_RANGE$2 ? "" : state.source.slice(event.tagStart, event.tagEnd);
      return rawTag2 === "" || rawTag2 === "!" ? defaultTagName : tagNameFull(rawTag2, state.tagHandlers);
    }
    function isMappingTag(tag) {
      return tag.nodeKind === "mapping";
    }
    function chargeMergeWork(state) {
      state.totalMergeKeys++;
      if (state.maxTotalMergeKeys !== -1 && state.totalMergeKeys > state.maxTotalMergeKeys) throwError$1(state, `merge keys exceeded maxTotalMergeKeys (${state.maxTotalMergeKeys})`);
    }
    function mergeKeys(state, frame, source, sourceTag) {
      chargeMergeWork(state);
      for (const sourceKey of sourceTag.keys(source)) {
        var _frame$overridable;
        chargeMergeWork(state);
        if (frame.tag.has(frame.value, sourceKey)) continue;
        const err = frame.tag.addPair(frame.value, sourceKey, sourceTag.get(source, sourceKey));
        if (err) throwError$1(state, err);
        (_frame$overridable = frame.overridable) !== null && _frame$overridable !== void 0 || (frame.overridable = /* @__PURE__ */ new Set());
        frame.overridable.add(sourceKey);
      }
    }
    function mergeSource(state, frame, source, sourceTag) {
      state.position = frame.keyPosition;
      if (isMappingTag(sourceTag)) mergeKeys(state, frame, source, sourceTag);
      else if (sourceTag.nodeKind === "sequence" && Array.isArray(source)) {
        if (source.length > 100) throwError$1(state, "abnormal merge sequence size");
        for (const element of source) {
          const elementTag = state.nodeTags.get(element);
          if (!elementTag) throwError$1(state, "cannot merge mappings; the provided source object is unacceptable");
          mergeKeys(state, frame, element, elementTag);
        }
      } else throwError$1(state, "cannot merge mappings; the provided source object is unacceptable");
    }
    function addMappingValue(state, frame, key, value, tag) {
      var _frame$overridable2, _frame$overridable3;
      state.position = frame.keyPosition;
      if (frame.keyIsMerge) {
        mergeSource(state, frame, value, tag);
        return;
      }
      if (!state.json && frame.tag.has(frame.value, key) && !((_frame$overridable2 = frame.overridable) === null || _frame$overridable2 === void 0 ? void 0 : _frame$overridable2.has(key))) throwError$1(state, "duplicated mapping key");
      const err = frame.tag.addPair(frame.value, key, value);
      if (err) throwError$1(state, err);
      (_frame$overridable3 = frame.overridable) === null || _frame$overridable3 === void 0 || _frame$overridable3.delete(key);
    }
    function addValue(state, value, tag) {
      const frame = state.frames[state.frames.length - 1];
      if (frame.kind === "document") {
        frame.value = value;
        frame.hasValue = true;
      } else if (frame.kind === "sequence") {
        if (isMappingTag(tag)) state.nodeTags.set(value, tag);
        const err = frame.tag.addItem(frame.value, value, frame.index++);
        if (err) throwError$1(state, err);
      } else if (frame.hasKey) {
        const key = frame.key;
        frame.key = void 0;
        frame.hasKey = false;
        addMappingValue(state, frame, key, value, tag);
      } else {
        frame.key = value;
        frame.keyPosition = state.position;
        frame.hasKey = true;
        frame.keyIsMerge = tag.tagName === MERGE_TAG_NAME;
      }
    }
    function storeAnchor(state, event, value, tag, isValueFinal) {
      if (event.anchorStart !== NO_RANGE$2) {
        const anchor = {
          value,
          tag,
          isValueFinal
        };
        state.anchors.set(state.source.slice(event.anchorStart, event.anchorEnd), anchor);
        return anchor;
      }
      return null;
    }
    function constructFromEvents(events, options) {
      const state = _objectSpread2(_objectSpread2(_objectSpread2({}, DEFAULT_CONSTRUCTOR_OPTIONS), options), {}, {
        events,
        documents: [],
        eventIndex: 0,
        position: 0,
        frames: [],
        anchors: /* @__PURE__ */ new Map(),
        nodeTags: /* @__PURE__ */ new Map(),
        tagHandlers: /* @__PURE__ */ Object.create(null),
        totalMergeKeys: 0,
        aliasCount: 0
      });
      while (state.eventIndex < state.events.length) {
        const event = state.events[state.eventIndex++];
        state.position = eventPosition$1(event);
        switch (event.type) {
          case EVENT_ID.DOCUMENT:
            state.anchors = /* @__PURE__ */ new Map();
            state.nodeTags = /* @__PURE__ */ new Map();
            state.aliasCount = 0;
            state.tagHandlers = /* @__PURE__ */ Object.create(null);
            for (const directive of event.directives) if (directive.kind === "tag") state.tagHandlers[directive.handle] = directive.prefix;
            state.frames.push({
              kind: "document",
              position: state.position,
              value: void 0,
              hasValue: false
            });
            break;
          case EVENT_ID.SCALAR: {
            const { value, tag } = constructScalar(state, event);
            storeAnchor(state, event, value, tag, true);
            addValue(state, value, tag);
            break;
          }
          case EVENT_ID.SEQUENCE: {
            const tagName = collectionTagName(state, event, "tag:yaml.org,2002:seq");
            const tag = state.schema.lookupSequenceTag(tagName);
            if (!tag) throwError$1(state, `unknown sequence tag !<${tagName}>`);
            const value = tag.create(tagName);
            const anchor = storeAnchor(state, event, value, tag, tag.carrierIsResult);
            state.frames.push({
              kind: "sequence",
              position: state.position,
              value,
              tag,
              anchor,
              index: 0
            });
            break;
          }
          case EVENT_ID.MAPPING: {
            const tagName = collectionTagName(state, event, "tag:yaml.org,2002:map");
            const tag = state.schema.lookupMappingTag(tagName);
            if (!tag) throwError$1(state, `unknown mapping tag !<${tagName}>`);
            const value = tag.create(tagName);
            const anchor = storeAnchor(state, event, value, tag, tag.carrierIsResult);
            state.frames.push({
              kind: "mapping",
              position: state.position,
              value,
              tag,
              anchor,
              key: void 0,
              keyPosition: state.position,
              hasKey: false,
              keyIsMerge: false,
              overridable: null
            });
            break;
          }
          case EVENT_ID.ALIAS: {
            if (state.maxAliases !== -1 && ++state.aliasCount > state.maxAliases) throwError$1(state, `aliases exceeded maxAliases (${state.maxAliases})`);
            const name = state.source.slice(event.anchorStart, event.anchorEnd);
            const anchor = state.anchors.get(name);
            if (!anchor) throwError$1(state, `unidentified alias "${name}"`);
            if (!anchor.isValueFinal) throwError$1(state, `recursive alias "${name}" is not supported for tag ${anchor.tag.tagName} because it uses finalize()`);
            addValue(state, anchor.value, anchor.tag);
            break;
          }
          case EVENT_ID.POP: {
            const frame = state.frames.pop();
            if (frame.kind === "mapping" && frame.hasKey) {
              state.position = frame.keyPosition;
              throwError$1(state, "incomplete mapping pair in event stream");
            }
            if (frame.kind === "document") state.documents.push(frame.value);
            else {
              const value = frame.tag.carrierIsResult ? frame.value : finalizeCollection(state, frame.position, frame.tag, frame.value);
              if (frame.anchor) {
                frame.anchor.value = value;
                frame.anchor.isValueFinal = true;
              }
              addValue(state, value, frame.tag);
            }
            break;
          }
        }
      }
      return state.documents;
    }
    var NO_RANGE$1 = -1;
    var HAS_OWN = Object.prototype.hasOwnProperty;
    var CONTEXT_FLOW_IN = 1;
    var CONTEXT_FLOW_OUT = 2;
    var CONTEXT_BLOCK_IN = 3;
    var CONTEXT_BLOCK_OUT = 4;
    var PATTERN_NON_PRINTABLE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x84\x86-\x9F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]/;
    var PATTERN_FLOW_INDICATORS = /[,\[\]{}]/;
    var PATTERN_TAG_HANDLE = /^(?:!|!!|![0-9A-Za-z-]+!)$/;
    var NS_URI_CHAR = String.raw`(?:%[0-9A-Fa-f]{2}|[0-9A-Za-z\-#;/?:@&=+$,_.!~*'()\[\]])`;
    var NS_TAG_CHAR = String.raw`(?:%[0-9A-Fa-f]{2}|[0-9A-Za-z\-#;/?:@&=+$.~*'()_])`;
    var PATTERN_TAG_URI = new RegExp(`^(?:${NS_URI_CHAR})*$`);
    var PATTERN_TAG_SUFFIX = new RegExp(`^(?:${NS_TAG_CHAR})+$`);
    var PATTERN_TAG_PREFIX = new RegExp(`^(?:!(?:${NS_URI_CHAR})*|${NS_TAG_CHAR}(?:${NS_URI_CHAR})*)$`);
    var DEFAULT_PARSER_OPTIONS = {
      filename: "",
      maxDepth: 100
    };
    function addDocumentEvent(state, explicitStart, explicitEnd) {
      state.events.push({
        type: EVENT_ID.DOCUMENT,
        explicitStart,
        explicitEnd,
        directives: state.directives
      });
    }
    function addSequenceEvent(state, start, anchorStart, anchorEnd, tagStart, tagEnd, style) {
      state.events.push({
        type: EVENT_ID.SEQUENCE,
        start,
        anchorStart,
        anchorEnd,
        tagStart,
        tagEnd,
        style
      });
    }
    function addMappingEvent(state, start, anchorStart, anchorEnd, tagStart, tagEnd, style) {
      state.events.push({
        type: EVENT_ID.MAPPING,
        start,
        anchorStart,
        anchorEnd,
        tagStart,
        tagEnd,
        style
      });
    }
    function insertFlowPairMappingEvent(state, snapshot) {
      state.events.splice(snapshot.eventsLength, 0, {
        type: EVENT_ID.MAPPING,
        start: snapshot.position,
        anchorStart: NO_RANGE$1,
        anchorEnd: NO_RANGE$1,
        tagStart: NO_RANGE$1,
        tagEnd: NO_RANGE$1,
        style: COLLECTION_STYLE.FLOW
      });
    }
    function addScalarEvent(state, valueStart, valueEnd, anchorStart, anchorEnd, tagStart, tagEnd, style, chomping = CHOMPING_MODE.CLIP, indent = -1, fast = false) {
      state.events.push({
        type: EVENT_ID.SCALAR,
        valueStart,
        valueEnd,
        anchorStart,
        anchorEnd,
        tagStart,
        tagEnd,
        style,
        chomping,
        indent,
        fast
      });
    }
    function addAliasEvent(state, anchorStart, anchorEnd) {
      state.events.push({
        type: EVENT_ID.ALIAS,
        anchorStart,
        anchorEnd
      });
    }
    function addPopEvent(state) {
      state.events.push({ type: EVENT_ID.POP });
    }
    function addEmptyScalarEvent(state) {
      addScalarEvent(state, NO_RANGE$1, NO_RANGE$1, NO_RANGE$1, NO_RANGE$1, NO_RANGE$1, NO_RANGE$1, SCALAR_STYLE.PLAIN);
    }
    function emptyProperties() {
      return {
        anchorStart: NO_RANGE$1,
        anchorEnd: NO_RANGE$1,
        tagStart: NO_RANGE$1,
        tagEnd: NO_RANGE$1
      };
    }
    function snapshotState(state) {
      return {
        position: state.position,
        line: state.line,
        lineStart: state.lineStart,
        lineIndent: state.lineIndent,
        firstTabInLine: state.firstTabInLine,
        eventsLength: state.events.length
      };
    }
    function restoreState(state, snapshot) {
      state.position = snapshot.position;
      state.line = snapshot.line;
      state.lineStart = snapshot.lineStart;
      state.lineIndent = snapshot.lineIndent;
      state.firstTabInLine = snapshot.firstTabInLine;
      state.events.length = snapshot.eventsLength;
    }
    function throwError(state, message) {
      YAMLException.throwAt(state.input.slice(0, state.length), state.position, message, state.filename);
    }
    function isEol(c) {
      return c === 10 || c === 13;
    }
    function isWhiteSpace(c) {
      return c === 9 || c === 32;
    }
    function isWsOrEol(c) {
      return isWhiteSpace(c) || isEol(c);
    }
    function isWsOrEolOrEnd(c) {
      return c === 0 || isWsOrEol(c);
    }
    function isFlowIndicator(c) {
      return c === 44 || c === 91 || c === 93 || c === 123 || c === 125;
    }
    function fromDecimalCode(c) {
      return c >= 48 && c <= 57 ? c - 48 : -1;
    }
    function fromHexCode(c) {
      if (c >= 48 && c <= 57) return c - 48;
      const lc = c | 32;
      if (lc >= 97 && lc <= 102) return lc - 97 + 10;
      return -1;
    }
    function escapedHexLen(c) {
      if (c === 120) return 2;
      if (c === 117) return 4;
      if (c === 85) return 8;
      return 0;
    }
    function isSimpleEscape(c) {
      return c === 48 || c === 97 || c === 98 || c === 116 || c === 9 || c === 110 || c === 118 || c === 102 || c === 114 || c === 101 || c === 32 || c === 34 || c === 47 || c === 92 || c === 78 || c === 95 || c === 76 || c === 80;
    }
    function consumeLineBreak(state) {
      if (state.input.charCodeAt(state.position) === 10) state.position++;
      else {
        state.position++;
        if (state.input.charCodeAt(state.position) === 10) state.position++;
      }
      state.line++;
      state.lineStart = state.position;
      state.lineIndent = 0;
      state.firstTabInLine = -1;
    }
    function skipSeparationSpace(state, allowComments) {
      let lineBreaks = 0;
      let ch = state.input.charCodeAt(state.position);
      let hasSeparation = state.position === state.lineStart || isWsOrEol(state.input.charCodeAt(state.position - 1));
      while (ch !== 0) {
        while (isWhiteSpace(ch)) {
          hasSeparation = true;
          if (ch === 9 && state.firstTabInLine === -1) state.firstTabInLine = state.position;
          ch = state.input.charCodeAt(++state.position);
        }
        if (allowComments && hasSeparation && ch === 35) do
          ch = state.input.charCodeAt(++state.position);
        while (!isEol(ch) && ch !== 0);
        if (!isEol(ch)) break;
        consumeLineBreak(state);
        lineBreaks++;
        hasSeparation = true;
        ch = state.input.charCodeAt(state.position);
        while (ch === 32) {
          state.lineIndent++;
          ch = state.input.charCodeAt(++state.position);
        }
      }
      return lineBreaks;
    }
    function testDocumentSeparator(state, position = state.position) {
      const ch = state.input.charCodeAt(position);
      if ((ch === 45 || ch === 46) && ch === state.input.charCodeAt(position + 1) && ch === state.input.charCodeAt(position + 2)) {
        const following = state.input.charCodeAt(position + 3);
        return following === 0 || isWsOrEol(following);
      }
      return false;
    }
    function skipByteOrderMark(state) {
      if (state.position === state.lineStart && state.input.charCodeAt(state.position) === 65279) {
        state.position++;
        state.lineStart = state.position;
      }
    }
    function testDocumentBoundary(state) {
      if (state.position !== state.lineStart) return false;
      if (testDocumentSeparator(state)) return true;
      if (state.input.charCodeAt(state.position) !== 65279) return false;
      const snapshot = snapshotState(state);
      skipByteOrderMark(state);
      skipSeparationSpace(state, true);
      const ch = state.input.charCodeAt(state.position);
      const result = state.position === state.lineStart && (ch === 37 || ch === 45 && testDocumentSeparator(state));
      restoreState(state, snapshot);
      return result;
    }
    function skipUntilLineEnd(state) {
      let ch = state.input.charCodeAt(state.position);
      while (ch !== 0 && !isEol(ch)) ch = state.input.charCodeAt(++state.position);
    }
    function checkPrintable(state, start, end) {
      if (PATTERN_NON_PRINTABLE.test(state.input.slice(start, end))) throwError(state, "the stream contains non-printable characters");
    }
    function readTagProperty(state, props, inFlow) {
      if (state.input.charCodeAt(state.position) !== 33) return false;
      if (props.tagStart !== NO_RANGE$1) throwError(state, "duplication of a tag property");
      const start = state.position;
      let isVerbatim = false;
      let isNamed = false;
      let tagHandle = "!";
      let ch = state.input.charCodeAt(++state.position);
      if (ch === 60) {
        isVerbatim = true;
        ch = state.input.charCodeAt(++state.position);
      } else if (ch === 33) {
        isNamed = true;
        tagHandle = "!!";
        ch = state.input.charCodeAt(++state.position);
      }
      let suffixStart = state.position;
      let tagName;
      if (isVerbatim) {
        while (ch !== 0 && ch !== 62) ch = state.input.charCodeAt(++state.position);
        if (ch !== 62) throwError(state, "unexpected end of the stream within a verbatim tag");
        tagName = state.input.slice(suffixStart, state.position);
        state.position++;
      } else {
        while (ch !== 0 && !isWsOrEol(ch) && !(inFlow && isFlowIndicator(ch))) {
          if (ch === 33) if (!isNamed) {
            tagHandle = state.input.slice(suffixStart - 1, state.position + 1);
            if (!PATTERN_TAG_HANDLE.test(tagHandle)) throwError(state, "named tag handle cannot contain such characters");
            isNamed = true;
            suffixStart = state.position + 1;
          } else throwError(state, "tag suffix cannot contain exclamation marks");
          ch = state.input.charCodeAt(++state.position);
        }
        tagName = state.input.slice(suffixStart, state.position);
        if (PATTERN_FLOW_INDICATORS.test(tagName)) throwError(state, "tag suffix cannot contain flow indicator characters");
      }
      if (tagName && !(isVerbatim ? PATTERN_TAG_URI.test(tagName) : PATTERN_TAG_SUFFIX.test(tagName))) throwError(state, `tag name cannot contain such characters: ${tagName}`);
      if (!isVerbatim && tagHandle !== "!" && tagHandle !== "!!" && !HAS_OWN.call(state.tagHandlers, tagHandle)) throwError(state, `undeclared tag handle "${tagHandle}"`);
      props.tagStart = start;
      props.tagEnd = state.position;
      return true;
    }
    function readAnchorProperty(state, props) {
      if (state.input.charCodeAt(state.position) !== 38) return false;
      if (props.anchorStart !== NO_RANGE$1) throwError(state, "duplication of an anchor property");
      state.position++;
      const start = state.position;
      while (state.input.charCodeAt(state.position) !== 0 && !isWsOrEol(state.input.charCodeAt(state.position)) && !isFlowIndicator(state.input.charCodeAt(state.position))) state.position++;
      if (state.position === start) throwError(state, "name of an anchor node must contain at least one character");
      props.anchorStart = start;
      props.anchorEnd = state.position;
      return true;
    }
    function readAlias(state, props) {
      if (state.input.charCodeAt(state.position) !== 42) return false;
      if (props.anchorStart !== NO_RANGE$1 || props.tagStart !== NO_RANGE$1) throwError(state, "alias node should not have any properties");
      state.position++;
      const start = state.position;
      while (state.input.charCodeAt(state.position) !== 0 && !isWsOrEol(state.input.charCodeAt(state.position)) && !isFlowIndicator(state.input.charCodeAt(state.position))) state.position++;
      if (state.position === start) throwError(state, "name of an alias node must contain at least one character");
      addAliasEvent(state, start, state.position);
      return true;
    }
    function readFlowScalarBreak(state, nodeIndent) {
      skipSeparationSpace(state, false);
      if (state.lineIndent < nodeIndent) throwError(state, "deficient indentation");
    }
    function readSingleQuotedScalar(state, nodeIndent, props) {
      if (state.input.charCodeAt(state.position) !== 39) return false;
      state.position++;
      const start = state.position;
      let simple = true;
      while (state.input.charCodeAt(state.position) !== 0) {
        const ch = state.input.charCodeAt(state.position);
        if (ch === 39) {
          if (state.input.charCodeAt(state.position + 1) === 39) {
            simple = false;
            state.position += 2;
            continue;
          }
          const end = state.position;
          state.position++;
          addScalarEvent(state, start, end, props.anchorStart, props.anchorEnd, props.tagStart, props.tagEnd, SCALAR_STYLE.SINGLE_QUOTED, CHOMPING_MODE.CLIP, -1, simple);
          return true;
        }
        if (isEol(ch)) {
          simple = false;
          readFlowScalarBreak(state, nodeIndent);
        } else if (state.position === state.lineStart && testDocumentSeparator(state)) throwError(state, "unexpected end of the document within a single quoted scalar");
        else if (ch !== 9 && ch < 32) throwError(state, "expected valid JSON character");
        else state.position++;
      }
      throwError(state, "unexpected end of the stream within a single quoted scalar");
    }
    function readDoubleQuotedScalar(state, nodeIndent, props) {
      if (state.input.charCodeAt(state.position) !== 34) return false;
      state.position++;
      const start = state.position;
      let simple = true;
      while (state.input.charCodeAt(state.position) !== 0) {
        const ch = state.input.charCodeAt(state.position);
        if (ch === 34) {
          const end = state.position;
          state.position++;
          addScalarEvent(state, start, end, props.anchorStart, props.anchorEnd, props.tagStart, props.tagEnd, SCALAR_STYLE.DOUBLE_QUOTED, CHOMPING_MODE.CLIP, -1, simple);
          return true;
        }
        if (ch === 92) {
          simple = false;
          const escaped = state.input.charCodeAt(++state.position);
          if (isEol(escaped)) readFlowScalarBreak(state, nodeIndent);
          else if (isSimpleEscape(escaped)) state.position++;
          else {
            let hexLength = escapedHexLen(escaped);
            if (hexLength === 0) throwError(state, "unknown escape sequence");
            while (hexLength-- > 0) {
              state.position++;
              if (fromHexCode(state.input.charCodeAt(state.position)) < 0) throwError(state, "expected hexadecimal character");
            }
            state.position++;
          }
        } else if (isEol(ch)) {
          simple = false;
          readFlowScalarBreak(state, nodeIndent);
        } else if (state.position === state.lineStart && testDocumentSeparator(state)) throwError(state, "unexpected end of the document within a double quoted scalar");
        else if (ch !== 9 && ch < 32) throwError(state, "expected valid JSON character");
        else state.position++;
      }
      throwError(state, "unexpected end of the stream within a double quoted scalar");
    }
    function readBlockScalar(state, parentIndent, props) {
      const ch = state.input.charCodeAt(state.position);
      let chomping = CHOMPING_MODE.CLIP;
      let indent = -1;
      let detectedIndent = false;
      if (ch !== 124 && ch !== 62) return false;
      const style = ch === 124 ? SCALAR_STYLE.LITERAL_BLOCK : SCALAR_STYLE.FOLDED_BLOCK;
      state.position++;
      while (state.input.charCodeAt(state.position) !== 0) {
        const current = state.input.charCodeAt(state.position);
        const digit = fromDecimalCode(current);
        if (current === 43 || current === 45) {
          if (chomping !== CHOMPING_MODE.CLIP) throwError(state, "repeat of a chomping mode identifier");
          chomping = current === 43 ? CHOMPING_MODE.KEEP : CHOMPING_MODE.STRIP;
          state.position++;
        } else if (digit >= 0) {
          if (digit === 0) throwError(state, "bad explicit indentation width of a block scalar; it cannot be less than one");
          if (detectedIndent) throwError(state, "repeat of an indentation width identifier");
          indent = parentIndent + digit - 1;
          detectedIndent = true;
          state.position++;
        } else break;
      }
      let hadWhitespace = false;
      while (isWhiteSpace(state.input.charCodeAt(state.position))) {
        hadWhitespace = true;
        state.position++;
      }
      if (hadWhitespace && state.input.charCodeAt(state.position) === 35) skipUntilLineEnd(state);
      if (isEol(state.input.charCodeAt(state.position))) consumeLineBreak(state);
      else if (state.input.charCodeAt(state.position) !== 0) throwError(state, "a line break is expected");
      let contentIndent = detectedIndent ? indent : -1;
      let maxLeadingIndent = 0;
      const valueStart = state.position;
      let valueEnd = state.position;
      while (state.input.charCodeAt(state.position) !== 0) {
        const linePosition = state.position;
        let column = 0;
        while (state.input.charCodeAt(linePosition + column) === 32) column++;
        const first = state.input.charCodeAt(linePosition + column);
        if (first === 0) {
          if (contentIndent >= 0) {
            if (column > contentIndent) valueEnd = linePosition + column;
          } else if (column > 0) valueEnd = linePosition + column;
          break;
        }
        if (testDocumentBoundary(state)) break;
        if (!detectedIndent && contentIndent === -1 && isEol(first)) maxLeadingIndent = Math.max(maxLeadingIndent, column);
        if (!detectedIndent && contentIndent === -1 && !isEol(first)) {
          if (first === 9 && column < parentIndent) {
            state.position = linePosition + column;
            throwError(state, "tab characters must not be used in indentation");
          }
          if (column < maxLeadingIndent) {
            state.position = linePosition + column;
            throwError(state, "bad indentation of a mapping entry");
          }
        }
        if (contentIndent === -1 && first !== 0 && !isEol(first) && column < parentIndent) {
          state.lineIndent = column;
          state.position = linePosition + column;
          break;
        }
        if (!detectedIndent && first !== 0 && !isEol(first) && contentIndent === -1) contentIndent = column;
        const requiredIndent = contentIndent === -1 ? parentIndent + 1 : contentIndent;
        if (first !== 0 && !isEol(first) && column < requiredIndent) {
          state.lineIndent = column;
          state.position = linePosition + column;
          break;
        }
        skipUntilLineEnd(state);
        valueEnd = state.position;
        if (isEol(state.input.charCodeAt(state.position))) {
          consumeLineBreak(state);
          valueEnd = state.position;
        }
      }
      checkPrintable(state, valueStart, valueEnd);
      addScalarEvent(state, valueStart, valueEnd, props.anchorStart, props.anchorEnd, props.tagStart, props.tagEnd, style, chomping, contentIndent);
      return true;
    }
    function canStartPlainScalar(state, nodeContext) {
      const ch = state.input.charCodeAt(state.position);
      const inFlow = nodeContext === CONTEXT_FLOW_IN;
      if (ch === 0 || isWsOrEol(ch) || ch === 35 || ch === 38 || ch === 42 || ch === 33 || ch === 124 || ch === 62 || ch === 39 || ch === 34 || ch === 37 || ch === 64 || ch === 96 || inFlow && isFlowIndicator(ch)) return false;
      if (ch === 63 || ch === 45) {
        const following = state.input.charCodeAt(state.position + 1);
        if (isWsOrEolOrEnd(following) || inFlow && isFlowIndicator(following)) return false;
      }
      return true;
    }
    function readPlainScalar(state, nodeIndent, nodeContext, props) {
      if (!canStartPlainScalar(state, nodeContext)) return false;
      const start = state.position;
      let end = state.position;
      let ch = state.input.charCodeAt(state.position);
      const inFlow = nodeContext === CONTEXT_FLOW_IN;
      let multiline = false;
      while (ch !== 0) {
        if (testDocumentBoundary(state)) break;
        if (ch === 58) {
          const following = state.input.charCodeAt(state.position + 1);
          if (isWsOrEolOrEnd(following) || inFlow && isFlowIndicator(following)) break;
        } else if (ch === 35) {
          if (isWsOrEol(state.input.charCodeAt(state.position - 1))) break;
        } else if (inFlow && isFlowIndicator(ch)) break;
        else if (isEol(ch)) {
          const savedPosition = state.position;
          const savedLine = state.line;
          const savedLineStart = state.lineStart;
          const savedLineIndent = state.lineIndent;
          skipSeparationSpace(state, false);
          if (state.lineIndent >= nodeIndent) {
            multiline = true;
            ch = state.input.charCodeAt(state.position);
            continue;
          }
          state.position = savedPosition;
          state.line = savedLine;
          state.lineStart = savedLineStart;
          state.lineIndent = savedLineIndent;
          break;
        }
        if (!isWhiteSpace(ch)) end = state.position + 1;
        ch = state.input.charCodeAt(++state.position);
      }
      if (end === start) return false;
      checkPrintable(state, start, end);
      addScalarEvent(state, start, end, props.anchorStart, props.anchorEnd, props.tagStart, props.tagEnd, SCALAR_STYLE.PLAIN, CHOMPING_MODE.CLIP, -1, !multiline);
      return true;
    }
    function skipFlowSeparationSpace(state, nodeIndent) {
      const startLine = state.line;
      skipSeparationSpace(state, true);
      if (state.line > startLine && state.lineIndent < nodeIndent || state.firstTabInLine !== -1 && state.lineIndent < nodeIndent) throwError(state, "deficient indentation");
    }
    function readFlowCollection(state, nodeIndent, props) {
      const ch = state.input.charCodeAt(state.position);
      const isMapping = ch === 123;
      const start = state.position;
      let readNext = true;
      if (ch !== 91 && ch !== 123) return false;
      const terminator = isMapping ? 125 : 93;
      if (isMapping) addMappingEvent(state, start, props.anchorStart, props.anchorEnd, props.tagStart, props.tagEnd, COLLECTION_STYLE.FLOW);
      else addSequenceEvent(state, start, props.anchorStart, props.anchorEnd, props.tagStart, props.tagEnd, COLLECTION_STYLE.FLOW);
      state.position++;
      while (state.input.charCodeAt(state.position) !== 0) {
        skipFlowSeparationSpace(state, nodeIndent);
        let ch2 = state.input.charCodeAt(state.position);
        if (ch2 === terminator) {
          state.position++;
          addPopEvent(state);
          return true;
        } else if (!readNext) throwError(state, "missed comma between flow collection entries");
        else if (ch2 === 44) throwError(state, "expected the node content, but found ','");
        let isPair = false;
        let isExplicitPair = false;
        if (ch2 === 63 && isWsOrEol(state.input.charCodeAt(state.position + 1))) {
          isPair = isExplicitPair = true;
          state.position += 1;
          skipFlowSeparationSpace(state, nodeIndent);
        }
        const entryLine = state.line;
        const entryStart = snapshotState(state);
        const keyWasRead = parseNode(state, nodeIndent, CONTEXT_FLOW_IN, false, true);
        skipFlowSeparationSpace(state, nodeIndent);
        ch2 = state.input.charCodeAt(state.position);
        if ((isMapping || isExplicitPair || state.line === entryLine) && ch2 === 58) {
          isPair = true;
          state.position++;
          skipFlowSeparationSpace(state, nodeIndent);
          if (!isMapping) {
            insertFlowPairMappingEvent(state, entryStart);
            if (!keyWasRead) addEmptyScalarEvent(state);
          } else if (!keyWasRead) addEmptyScalarEvent(state);
          if (!parseNode(state, nodeIndent, CONTEXT_FLOW_IN, false, true)) addEmptyScalarEvent(state);
          skipFlowSeparationSpace(state, nodeIndent);
          if (!isMapping) addPopEvent(state);
        } else if (isMapping && isPair) {
          if (!keyWasRead) addEmptyScalarEvent(state);
          addEmptyScalarEvent(state);
        } else if (isMapping) addEmptyScalarEvent(state);
        else if (isPair) {
          insertFlowPairMappingEvent(state, entryStart);
          if (!keyWasRead) addEmptyScalarEvent(state);
          addEmptyScalarEvent(state);
          addPopEvent(state);
        }
        ch2 = state.input.charCodeAt(state.position);
        if (ch2 === 44) {
          readNext = true;
          state.position++;
        } else readNext = false;
      }
      throwError(state, "unexpected end of the stream within a flow collection");
    }
    function readBlockSequence(state, nodeIndent, props) {
      if (state.firstTabInLine !== -1 || state.input.charCodeAt(state.position) !== 45 || !isWsOrEolOrEnd(state.input.charCodeAt(state.position + 1))) return false;
      addSequenceEvent(state, state.position, props.anchorStart, props.anchorEnd, props.tagStart, props.tagEnd, COLLECTION_STYLE.BLOCK);
      while (state.input.charCodeAt(state.position) === 45 && isWsOrEolOrEnd(state.input.charCodeAt(state.position + 1))) {
        if (state.firstTabInLine !== -1) {
          state.position = state.firstTabInLine;
          throwError(state, "tab characters must not be used in indentation");
        }
        const entryLine = state.line;
        state.position++;
        const hadBreak = skipSeparationSpace(state, true) > 0;
        if (state.firstTabInLine !== -1 && state.input.charCodeAt(state.position) === 45 && isWsOrEolOrEnd(state.input.charCodeAt(state.position + 1))) throwError(state, "bad indentation of a sequence entry");
        if (hadBreak && state.lineIndent <= nodeIndent) addEmptyScalarEvent(state);
        else parseNode(state, nodeIndent, CONTEXT_BLOCK_IN, false, true);
        skipSeparationSpace(state, true);
        if (state.lineIndent < nodeIndent || state.position >= state.length) break;
        if (state.lineIndent > nodeIndent) throwError(state, "bad indentation of a sequence entry");
        if (state.line === entryLine && state.input.charCodeAt(state.position) === 45 && isWsOrEolOrEnd(state.input.charCodeAt(state.position + 1))) throwError(state, "bad indentation of a sequence entry");
      }
      addPopEvent(state);
      return true;
    }
    function readBlockMapping(state, nodeIndent, flowIndent, props) {
      let atExplicitKey = false;
      let detected = false;
      let mappingOpened = false;
      let pendingExplicitKey = false;
      if (state.firstTabInLine !== -1) return false;
      let ch = state.input.charCodeAt(state.position);
      while (ch !== 0) {
        if (!atExplicitKey && state.firstTabInLine !== -1) {
          state.position = state.firstTabInLine;
          throwError(state, "tab characters must not be used in indentation");
        }
        const following = state.input.charCodeAt(state.position + 1);
        const entryLine = state.line;
        if ((ch === 63 || ch === 58) && isWsOrEolOrEnd(following)) {
          if (!mappingOpened) {
            addMappingEvent(state, state.position, props.anchorStart, props.anchorEnd, props.tagStart, props.tagEnd, COLLECTION_STYLE.BLOCK);
            mappingOpened = true;
          }
          if (ch === 63) {
            if (atExplicitKey) addEmptyScalarEvent(state);
            detected = true;
            atExplicitKey = true;
          } else if (atExplicitKey) atExplicitKey = false;
          else {
            addEmptyScalarEvent(state);
            detected = true;
            atExplicitKey = false;
          }
          state.position += 1;
          pendingExplicitKey = true;
        } else {
          if (atExplicitKey) {
            addEmptyScalarEvent(state);
            atExplicitKey = false;
          }
          const beforeKey = snapshotState(state);
          if (!parseNode(state, flowIndent, CONTEXT_FLOW_OUT, false, true)) break;
          if (state.line === entryLine) {
            ch = state.input.charCodeAt(state.position);
            while (isWhiteSpace(ch)) ch = state.input.charCodeAt(++state.position);
            if (ch === 58) {
              ch = state.input.charCodeAt(++state.position);
              if (!isWsOrEolOrEnd(ch)) throwError(state, "a whitespace character is expected after the key-value separator within a block mapping");
              if (!mappingOpened) {
                restoreState(state, beforeKey);
                addMappingEvent(state, beforeKey.position, props.anchorStart, props.anchorEnd, props.tagStart, props.tagEnd, COLLECTION_STYLE.BLOCK);
                mappingOpened = true;
                parseNode(state, flowIndent, CONTEXT_FLOW_OUT, false, true);
                ch = state.input.charCodeAt(state.position);
                while (isWhiteSpace(ch)) ch = state.input.charCodeAt(++state.position);
                state.position++;
              }
              detected = true;
              atExplicitKey = false;
              pendingExplicitKey = false;
            } else if (detected) throwError(state, "expected ':' after a mapping key");
            else {
              if (props.anchorStart !== NO_RANGE$1 || props.tagStart !== NO_RANGE$1) {
                restoreState(state, beforeKey);
                return false;
              }
              return true;
            }
          } else if (detected) throwError(state, "can not read a block mapping entry; a multiline key may not be an implicit key");
          else {
            if (props.anchorStart !== NO_RANGE$1 || props.tagStart !== NO_RANGE$1) {
              restoreState(state, beforeKey);
              return false;
            }
            return true;
          }
        }
        if (parseNode(state, nodeIndent, CONTEXT_BLOCK_OUT, true, pendingExplicitKey)) pendingExplicitKey = false;
        if (!atExplicitKey) {
          if (pendingExplicitKey) {
            addEmptyScalarEvent(state);
            pendingExplicitKey = false;
          }
        }
        skipSeparationSpace(state, true);
        ch = state.input.charCodeAt(state.position);
        if ((state.line === entryLine || state.lineIndent > nodeIndent) && ch !== 0) throwError(state, "bad indentation of a mapping entry");
        else if (state.lineIndent < nodeIndent) break;
      }
      if (!detected) return false;
      if (atExplicitKey) addEmptyScalarEvent(state);
      if (mappingOpened) addPopEvent(state);
      return true;
    }
    function parseNode(state, parentIndent, nodeContext, allowToSeek, allowCompact, allowPropertyMapping = true) {
      if (state.depth >= state.maxDepth) throwError(state, `nesting exceeded maxDepth (${state.maxDepth})`);
      state.depth++;
      let indentStatus = 1;
      let atNewLine = false;
      let hasContent = false;
      let propertyStart = null;
      const props = emptyProperties();
      let allowBlockScalars = nodeContext === CONTEXT_BLOCK_OUT || nodeContext === CONTEXT_BLOCK_IN;
      let allowBlockCollections = allowBlockScalars;
      const allowBlockStyles = allowBlockScalars;
      if (allowToSeek && skipSeparationSpace(state, true)) {
        atNewLine = true;
        if (state.lineIndent > parentIndent) indentStatus = 1;
        else if (state.lineIndent === parentIndent) indentStatus = 0;
        else indentStatus = -1;
      }
      if (indentStatus === 1) while (true) {
        const ch = state.input.charCodeAt(state.position);
        const propertyState = snapshotState(state);
        if (atNewLine && indentStatus !== 1 && (ch === 33 || ch === 38)) break;
        if (atNewLine && allowBlockStyles && (props.tagStart !== NO_RANGE$1 || props.anchorStart !== NO_RANGE$1) && (ch === 33 || ch === 38)) {
          var _state$events$fallbac;
          const fallbackState = snapshotState(state);
          const flowIndent = parentIndent + 1;
          if (readBlockMapping(state, state.position - state.lineStart, flowIndent, props) && ((_state$events$fallbac = state.events[fallbackState.eventsLength]) === null || _state$events$fallbac === void 0 ? void 0 : _state$events$fallbac.type) === EVENT_ID.MAPPING) {
            state.depth--;
            return true;
          }
          restoreState(state, fallbackState);
        }
        if (atNewLine && (ch === 33 && props.tagStart !== NO_RANGE$1 || ch === 38 && props.anchorStart !== NO_RANGE$1)) break;
        if (!readTagProperty(state, props, nodeContext === CONTEXT_FLOW_IN) && !readAnchorProperty(state, props)) break;
        if (propertyStart === null) propertyStart = propertyState;
        if (skipSeparationSpace(state, true)) {
          atNewLine = true;
          allowBlockCollections = allowBlockStyles;
          if (state.lineIndent > parentIndent) indentStatus = 1;
          else if (state.lineIndent === parentIndent) indentStatus = 0;
          else indentStatus = -1;
        } else allowBlockCollections = false;
      }
      if (allowBlockCollections) allowBlockCollections = atNewLine || allowCompact;
      if (indentStatus === 1 || nodeContext === CONTEXT_BLOCK_OUT) {
        const flowIndent = nodeContext === CONTEXT_FLOW_IN || nodeContext === CONTEXT_FLOW_OUT ? parentIndent : parentIndent + 1;
        const blockIndent = state.position - state.lineStart;
        if (indentStatus === 1) if (allowBlockCollections && (readBlockSequence(state, blockIndent, props) || readBlockMapping(state, blockIndent, flowIndent, props)) || readFlowCollection(state, flowIndent, props)) hasContent = true;
        else {
          const ch = state.input.charCodeAt(state.position);
          if (propertyStart !== null && allowPropertyMapping && allowBlockStyles && !allowBlockCollections && ch !== 124 && ch !== 62) {
            var _state$events$fallbac2;
            const fallbackState = snapshotState(state);
            const propertyIndent = propertyStart.position - propertyStart.lineStart;
            restoreState(state, propertyStart);
            if (readBlockMapping(state, propertyIndent, flowIndent, emptyProperties()) && ((_state$events$fallbac2 = state.events[fallbackState.eventsLength]) === null || _state$events$fallbac2 === void 0 ? void 0 : _state$events$fallbac2.type) === EVENT_ID.MAPPING) hasContent = true;
            else restoreState(state, fallbackState);
          }
          if (!hasContent && (allowBlockScalars && readBlockScalar(state, flowIndent, props) || readSingleQuotedScalar(state, flowIndent, props) || readDoubleQuotedScalar(state, flowIndent, props) || readAlias(state, props) || readPlainScalar(state, flowIndent, nodeContext, props))) hasContent = true;
        }
        else if (indentStatus === 0) hasContent = allowBlockCollections && readBlockSequence(state, blockIndent, props);
      }
      allowBlockScalars = allowBlockScalars && !hasContent;
      if (!hasContent && (props.anchorStart !== NO_RANGE$1 || props.tagStart !== NO_RANGE$1 || allowBlockScalars)) {
        addScalarEvent(state, NO_RANGE$1, NO_RANGE$1, props.anchorStart, props.anchorEnd, props.tagStart, props.tagEnd, SCALAR_STYLE.PLAIN);
        hasContent = true;
      }
      state.depth--;
      return hasContent || props.anchorStart !== NO_RANGE$1 || props.tagStart !== NO_RANGE$1;
    }
    function readDirective(state) {
      if (state.lineIndent > 0 || state.input.charCodeAt(state.position) !== 37) return false;
      state.position++;
      const nameStart = state.position;
      while (state.input.charCodeAt(state.position) !== 0 && !isWsOrEol(state.input.charCodeAt(state.position))) state.position++;
      const name = state.input.slice(nameStart, state.position);
      const args = [];
      if (name.length === 0) throwError(state, "directive name must not be less than one character in length");
      while (state.input.charCodeAt(state.position) !== 0 && !isEol(state.input.charCodeAt(state.position))) {
        while (isWhiteSpace(state.input.charCodeAt(state.position))) state.position++;
        if (state.input.charCodeAt(state.position) === 35 || isEol(state.input.charCodeAt(state.position)) || state.input.charCodeAt(state.position) === 0) break;
        const start = state.position;
        while (state.input.charCodeAt(state.position) !== 0 && !isWsOrEol(state.input.charCodeAt(state.position))) state.position++;
        args.push(state.input.slice(start, state.position));
      }
      if (isEol(state.input.charCodeAt(state.position))) consumeLineBreak(state);
      if (name === "YAML") {
        if (state.directives.some((directive) => directive.kind === "yaml")) throwError(state, "duplication of %YAML directive");
        if (args.length !== 1) throwError(state, "YAML directive accepts exactly one argument");
        const match = /^([0-9]+)\.([0-9]+)$/.exec(args[0]);
        if (match === null) throwError(state, "ill-formed argument of the YAML directive");
        if (parseInt(match[1], 10) !== 1) throwError(state, "unacceptable YAML version of the document");
        state.directives.push({
          kind: "yaml",
          version: args[0]
        });
      } else if (name === "TAG") {
        if (args.length !== 2) throwError(state, "TAG directive accepts exactly two arguments");
        const [handle, prefix] = args;
        if (!PATTERN_TAG_HANDLE.test(handle)) throwError(state, "ill-formed tag handle (first argument) of the TAG directive");
        if (HAS_OWN.call(state.tagHandlers, handle)) throwError(state, `there is a previously declared suffix for "${handle}" tag handle`);
        if (!PATTERN_TAG_PREFIX.test(prefix)) throwError(state, "ill-formed tag prefix (second argument) of the TAG directive");
        state.tagHandlers[handle] = prefix;
        state.directives.push({
          kind: "tag",
          handle,
          prefix
        });
      }
      return true;
    }
    function readDocument(state) {
      state.directives = [];
      state.tagHandlers = /* @__PURE__ */ Object.create(null);
      let hasDirectives = false;
      skipSeparationSpace(state, true);
      while (readDirective(state)) {
        hasDirectives = true;
        skipSeparationSpace(state, true);
      }
      let explicitStart = false;
      let explicitEnd = false;
      let allowCompact = true;
      if (state.lineIndent === 0 && state.input.charCodeAt(state.position) === 45 && state.input.charCodeAt(state.position + 1) === 45 && state.input.charCodeAt(state.position + 2) === 45 && isWsOrEolOrEnd(state.input.charCodeAt(state.position + 3))) {
        explicitStart = true;
        const markerLine = state.line;
        state.position += 3;
        skipSeparationSpace(state, true);
        allowCompact = state.line > markerLine;
      } else if (hasDirectives) throwError(state, "directives end mark is expected");
      const documentEventIndex = state.events.length;
      if (!explicitStart && state.position === state.lineStart && state.input.charCodeAt(state.position) === 46 && testDocumentSeparator(state)) {
        state.position += 3;
        skipSeparationSpace(state, true);
        return;
      }
      addDocumentEvent(state, explicitStart, false);
      if (!parseNode(state, state.lineIndent - 1, CONTEXT_BLOCK_OUT, false, allowCompact, allowCompact)) addEmptyScalarEvent(state);
      skipSeparationSpace(state, true);
      if (state.position === state.lineStart && testDocumentSeparator(state)) {
        explicitEnd = state.input.charCodeAt(state.position) === 46;
        if (explicitEnd) {
          const markerLine = state.line;
          state.position += 3;
          skipSeparationSpace(state, true);
          if (state.line === markerLine && state.position < state.length) throwError(state, "end of the stream or a document separator is expected");
        }
      }
      const documentEvent = state.events[documentEventIndex];
      if ((documentEvent === null || documentEvent === void 0 ? void 0 : documentEvent.type) === EVENT_ID.DOCUMENT) documentEvent.explicitEnd = explicitEnd;
      addPopEvent(state);
      if (!explicitEnd && state.position < state.length && !testDocumentBoundary(state)) throwError(state, "end of the stream or a document separator is expected");
    }
    function parseEvents(input, options) {
      const length = input.length;
      const state = _objectSpread2(_objectSpread2(_objectSpread2({}, DEFAULT_PARSER_OPTIONS), options), {}, {
        input: `${input}\0`,
        length,
        position: 0,
        line: 0,
        lineStart: 0,
        lineIndent: 0,
        firstTabInLine: -1,
        depth: 0,
        directives: [],
        tagHandlers: /* @__PURE__ */ Object.create(null),
        events: []
      });
      const nullpos = input.indexOf("\0");
      if (nullpos !== -1) YAMLException.throwAt(input, nullpos, "null byte is not allowed in input", state.filename);
      while (state.position < state.length) {
        skipByteOrderMark(state);
        skipSeparationSpace(state, true);
        if (state.position >= state.length) break;
        const documentStart = state.position;
        readDocument(state);
        if (state.position === documentStart)
          throwError(state, "can not read a document");
      }
      return state.events;
    }
    var DEFAULT_LOAD_OPTIONS = _objectSpread2(_objectSpread2({}, DEFAULT_PARSER_OPTIONS), DEFAULT_CONSTRUCTOR_OPTIONS);
    function loadDocuments(input, options = {}) {
      const opts = _objectSpread2(_objectSpread2({}, DEFAULT_LOAD_OPTIONS), options);
      const source = String(input);
      const PARSER_OPT_KEYS = Object.keys(DEFAULT_PARSER_OPTIONS);
      const CONSTRUCTOR_OPT_KEYS = Object.keys(DEFAULT_CONSTRUCTOR_OPTIONS);
      return constructFromEvents(parseEvents(source, pick(opts, PARSER_OPT_KEYS)), _objectSpread2(_objectSpread2({}, pick(opts, CONSTRUCTOR_OPT_KEYS)), {}, { source }));
    }
    function loadAll(input, iteratorOrOptions, options) {
      let iterator = null;
      if (typeof iteratorOrOptions === "function") iterator = iteratorOrOptions;
      else if (iteratorOrOptions !== null && typeof iteratorOrOptions === "object") options = iteratorOrOptions;
      const documents = loadDocuments(input, options);
      if (iterator === null) return documents;
      for (const document2 of documents) iterator(document2);
    }
    function load(input, options) {
      const documents = loadDocuments(input, options);
      if (documents.length === 0) throw new YAMLException("expected a document, but the input is empty");
      if (documents.length === 1) return documents[0];
      throw new YAMLException("expected a single document in the stream, but found more");
    }
    var INVALID = /* @__PURE__ */ Symbol("INVALID");
    function buildRepresentTypes(schema) {
      const defaultTags = new Set([
        schema.defaultScalarTag,
        schema.defaultSequenceTag,
        schema.defaultMappingTag
      ].filter((t) => t !== void 0));
      const implicitScalars = schema.implicitScalarTags;
      const explicitTags = schema.tags.filter((t) => !(t.nodeKind === "scalar" && t.implicit) && !defaultTags.has(t));
      const defaultTagsLast = schema.tags.filter((t) => defaultTags.has(t));
      return [
        ...implicitScalars.map((tag) => ({
          tag,
          implicitTag: true
        })),
        ...explicitTags.map((tag) => ({
          tag,
          implicitTag: false
        })),
        ...defaultTagsLast.map((tag) => ({
          tag,
          implicitTag: true
        }))
      ];
    }
    function matchTag(state, object) {
      for (let index = 0, length = state.representTypes.length; index < length; index += 1) {
        const { tag, implicitTag } = state.representTypes[index];
        if (tag.identify(object)) {
          let tagName;
          if (tag.matchByTagPrefix) tagName = tag.representTagName(object);
          else tagName = tag.tagName;
          return {
            tag,
            tagName,
            implicitTag
          };
        }
      }
      return null;
    }
    function build(state, object) {
      if (!state.noRefs && object !== null && typeof object === "object") {
        const existing = state.refs.get(object);
        if (existing) {
          if (existing.anchor === void 0) existing.anchor = `ref_${state.refCounter++}`;
          return {
            kind: "alias",
            anchor: existing.anchor
          };
        }
      }
      const matched = matchTag(state, object);
      if (!matched) {
        if (object === void 0) return INVALID;
        if (state.skipInvalid) return INVALID;
        throw new YAMLException(`unacceptable kind of an object to dump ${Object.prototype.toString.call(object)}`);
      }
      const { tag, tagName, implicitTag } = matched;
      const nodeTagName = implicitTag ? tagName : tagNameShort(tagName);
      if (tag.nodeKind === "scalar") return {
        kind: "scalar",
        tag: nodeTagName,
        tagged: !implicitTag,
        style: SCALAR_STYLE.PLAIN,
        value: tag.represent(object)
      };
      if (tag.nodeKind === "sequence") {
        const container = tag.represent(object);
        const node2 = {
          kind: "sequence",
          tag: nodeTagName,
          tagged: !implicitTag,
          style: COLLECTION_STYLE.BLOCK,
          items: []
        };
        if (!state.noRefs) state.refs.set(object, node2);
        for (let index = 0, length = container.length; index < length; index += 1) {
          let item = build(state, container[index]);
          if (item === INVALID && container[index] === void 0) item = build(state, null);
          if (item === INVALID) continue;
          node2.items.push(item);
        }
        return node2;
      }
      const map = tag.represent(object);
      const node = {
        kind: "mapping",
        tag: nodeTagName,
        tagged: !implicitTag,
        style: COLLECTION_STYLE.BLOCK,
        items: []
      };
      if (!state.noRefs) state.refs.set(object, node);
      for (const [objectKey, objectValue] of map) {
        const key = build(state, objectKey);
        if (key === INVALID) continue;
        const value = build(state, objectValue);
        if (value === INVALID) continue;
        node.items.push({
          key,
          value
        });
      }
      return node;
    }
    function jsToAst(input, schema, options = {}) {
      var _options$noRefs, _options$skipInvalid;
      const root = build({
        representTypes: buildRepresentTypes(schema),
        noRefs: (_options$noRefs = options.noRefs) !== null && _options$noRefs !== void 0 ? _options$noRefs : false,
        skipInvalid: (_options$skipInvalid = options.skipInvalid) !== null && _options$skipInvalid !== void 0 ? _options$skipInvalid : false,
        refs: /* @__PURE__ */ new Map(),
        refCounter: 0
      }, input);
      return [{
        contents: root === INVALID ? null : root,
        directives: []
      }];
    }
    var VISIT_BREAK = /* @__PURE__ */ Symbol("visit:break");
    var VISIT_SKIP = /* @__PURE__ */ Symbol("visit:skip");
    function visitNode(node, visitor, ctx) {
      const control = visitor(node, ctx);
      if (control === VISIT_BREAK) return true;
      if (control === VISIT_SKIP) return false;
      const depth = ctx.depth + 1;
      switch (node.kind) {
        case "sequence":
          for (const item of node.items) if (visitNode(item, visitor, {
            depth,
            parent: node,
            isKey: false
          })) return true;
          break;
        case "mapping":
          for (const { key, value } of node.items) {
            if (visitNode(key, visitor, {
              depth,
              parent: node,
              isKey: true
            })) return true;
            if (visitNode(value, visitor, {
              depth,
              parent: node,
              isKey: false
            })) return true;
          }
          break;
      }
      return false;
    }
    function visit(documents, visitor) {
      for (const doc of documents) if (doc.contents && visitNode(doc.contents, visitor, {
        depth: 0,
        parent: null,
        isKey: false
      })) return;
    }
    function hasBit(mask, bit) {
      return (mask & 1 << bit) !== 0;
    }
    var DEFAULT_SCALAR_STYLE_RULES = {
      applyQuoteFlowKeysOption,
      doubleQuoteForInvisibles,
      doubleQuoteWhitespaceOnly,
      applyForceQuotesOption,
      tryLongOrMultilineAsBlock,
      quoteInvalidPlain,
      fallbackToDoubleQuoted
    };
    function _preferredQuotedStyle(layout) {
      if (layout.presenterOptions.quoteStyle === "single" && hasBit(layout.allowedStylesMask, SCALAR_STYLE.SINGLE_QUOTED)) return SCALAR_STYLE.SINGLE_QUOTED;
      return SCALAR_STYLE.DOUBLE_QUOTED;
    }
    function applyQuoteFlowKeysOption(layout) {
      if (!layout.presenterOptions.quoteFlowKeys) return;
      if (!layout.isKey || !layout.flowOnly || layout.style !== SCALAR_STYLE.PLAIN) return;
      layout.style = SCALAR_STYLE.DOUBLE_QUOTED;
    }
    function doubleQuoteForInvisibles(layout) {
      if (layout.style === SCALAR_STYLE.PLAIN && /[\t\x7F-\xA0\u2028\u2029\uFEFF\uFFFE\uFFFF]/.test(layout.node.value)) layout.style = SCALAR_STYLE.DOUBLE_QUOTED;
    }
    function doubleQuoteWhitespaceOnly(layout) {
      if (layout.style === SCALAR_STYLE.PLAIN && /^\s+$/.test(layout.node.value)) layout.style = SCALAR_STYLE.DOUBLE_QUOTED;
    }
    function applyForceQuotesOption(layout) {
      if (!layout.presenterOptions.forceQuotes) return;
      if (layout.isKey || layout.style !== SCALAR_STYLE.PLAIN) return;
      layout.style = layout.node.value.includes("\n") ? SCALAR_STYLE.DOUBLE_QUOTED : _preferredQuotedStyle(layout);
    }
    function tryLongOrMultilineAsBlock(layout) {
      if (layout.style !== SCALAR_STYLE.PLAIN || layout.isKey) return;
      const value = layout.node.value;
      const multiline = value.indexOf("\n") !== -1;
      if (!hasBit(layout.allowedStylesMask, SCALAR_STYLE.LITERAL_BLOCK)) {
        if (multiline) layout.style = SCALAR_STYLE.DOUBLE_QUOTED;
        return;
      }
      const w = layout.presenterOptions.lineWidth;
      if (w === -1) {
        if (multiline) layout.style = SCALAR_STYLE.LITERAL_BLOCK;
        return;
      }
      const availableWidth = Math.max(Math.min(w, 40), w - layout.shiftOfContent);
      let position = 0;
      let shouldFold = false;
      while (position <= value.length) {
        let lineEnd = value.length;
        const nextLineBreak = value.indexOf("\n", position);
        if (nextLineBreak !== -1) lineEnd = nextLineBreak;
        const line = value.slice(position, lineEnd);
        if (line.length > availableWidth && line[0] !== " " && / [^ \t]/.test(line)) shouldFold = true;
        if (nextLineBreak === -1) break;
        position = nextLineBreak + 1;
      }
      if (shouldFold) layout.style = SCALAR_STYLE.FOLDED_BLOCK;
      else if (multiline) layout.style = SCALAR_STYLE.LITERAL_BLOCK;
    }
    function quoteInvalidPlain(layout) {
      if (layout.style === SCALAR_STYLE.PLAIN && !hasBit(layout.allowedStylesMask, SCALAR_STYLE.PLAIN)) layout.style = _preferredQuotedStyle(layout);
    }
    function fallbackToDoubleQuoted(layout) {
      if (!hasBit(layout.allowedStylesMask, layout.style)) layout.style = SCALAR_STYLE.DOUBLE_QUOTED;
    }
    function setBit(mask, bit) {
      return mask | 1 << bit;
    }
    var SRC_C_PRINTABLE = "[\\x09\\x0A\\x0D\\x20-\\x7E\\x85\\xA0-\\uD7FF\\uE000-\\uFFFD\\u{10000}-\\u{10FFFF}]";
    var SRC_B_CHAR = "[\\n\\r]";
    var SRC_C_BYTE_ORDER_MARK = "\\uFEFF";
    var SRC_S_WHITE = "[ \\t]";
    var SRC_NB_CHAR = `(?:(?!(?:${SRC_B_CHAR}|${SRC_C_BYTE_ORDER_MARK}))${SRC_C_PRINTABLE})`;
    var SRC_NS_CHAR = `(?:(?!${SRC_S_WHITE})${SRC_NB_CHAR})`;
    var SRC_NB_JSON = "[\\x09\\x20-\\uD7FF\\uE000-\\uFFFF\\u{10000}-\\u{10FFFF}]";
    var SRC_C_INDICATOR = "[-?:,\\[\\]{}#&*!|>'\"%@`]";
    var SRC_C_FLOW_INDICATOR = "[,\\[\\]{}]";
    var SRC_NS_PLAIN_SAFE_FLOW_OUT = SRC_NS_CHAR;
    var SRC_NS_PLAIN_SAFE_FLOW_IN = `(?:(?!${SRC_C_FLOW_INDICATOR})${SRC_NS_CHAR})`;
    var SRC_NS_PLAIN_FIRST_FLOW_OUT = `(?:(?:(?!${SRC_C_INDICATOR})${SRC_NS_CHAR})|[?:-](?=${SRC_NS_PLAIN_SAFE_FLOW_OUT}))`;
    var SRC_NS_PLAIN_FIRST_FLOW_IN = `(?:(?:(?!${SRC_C_INDICATOR})${SRC_NS_CHAR})|[?:-](?=${SRC_NS_PLAIN_SAFE_FLOW_IN}))`;
    var SRC_NS_PLAIN_CHAR_FLOW_OUT = `(?:(?:(?![:#])${SRC_NS_PLAIN_SAFE_FLOW_OUT})|:(?=${SRC_NS_PLAIN_SAFE_FLOW_OUT}))#*`;
    var SRC_NS_PLAIN_CHAR_FLOW_IN = `(?:(?:(?![:#])${SRC_NS_PLAIN_SAFE_FLOW_IN})|:(?=${SRC_NS_PLAIN_SAFE_FLOW_IN}))#*`;
    var SRC_NB_NS_PLAIN_IN_LINE_FLOW_OUT = `(?:${SRC_S_WHITE}*${SRC_NS_PLAIN_CHAR_FLOW_OUT})*`;
    var SRC_NB_NS_PLAIN_IN_LINE_FLOW_IN = `(?:${SRC_S_WHITE}*${SRC_NS_PLAIN_CHAR_FLOW_IN})*`;
    var SRC_NS_PLAIN_ONE_LINE_FLOW_OUT = `${SRC_NS_PLAIN_FIRST_FLOW_OUT}#*${SRC_NB_NS_PLAIN_IN_LINE_FLOW_OUT}`;
    var SRC_NS_PLAIN_ONE_LINE_FLOW_IN = `${SRC_NS_PLAIN_FIRST_FLOW_IN}#*${SRC_NB_NS_PLAIN_IN_LINE_FLOW_IN}`;
    var SRC_NS_PLAIN_ONE_LINE_BLOCK_KEY = SRC_NS_PLAIN_ONE_LINE_FLOW_OUT;
    var SRC_NS_PLAIN_ONE_LINE_FLOW_KEY = SRC_NS_PLAIN_ONE_LINE_FLOW_IN;
    var SRC_S_NS_PLAIN_NEXT_LINE_FLOW_OUT = `\\n+${SRC_NS_PLAIN_CHAR_FLOW_OUT}${SRC_NB_NS_PLAIN_IN_LINE_FLOW_OUT}`;
    var SRC_S_NS_PLAIN_NEXT_LINE_FLOW_IN = `\\n+${SRC_NS_PLAIN_CHAR_FLOW_IN}${SRC_NB_NS_PLAIN_IN_LINE_FLOW_IN}`;
    var SRC_NS_PLAIN_MULTI_LINE_FLOW_OUT = `${SRC_NS_PLAIN_ONE_LINE_FLOW_OUT}(?:${SRC_S_NS_PLAIN_NEXT_LINE_FLOW_OUT})*`;
    var SRC_NS_PLAIN_MULTI_LINE_FLOW_IN = `${SRC_NS_PLAIN_ONE_LINE_FLOW_IN}(?:${SRC_S_NS_PLAIN_NEXT_LINE_FLOW_IN})*`;
    var NS_PLAIN_FLOW_OUT = new RegExp(`^(?:${SRC_NS_PLAIN_MULTI_LINE_FLOW_OUT})$`, "u");
    var NS_PLAIN_FLOW_IN = new RegExp(`^(?:${SRC_NS_PLAIN_MULTI_LINE_FLOW_IN})$`, "u");
    var NS_PLAIN_BLOCK_KEY = new RegExp(`^(?:${SRC_NS_PLAIN_ONE_LINE_BLOCK_KEY})$`, "u");
    var NS_PLAIN_FLOW_KEY = new RegExp(`^(?:${SRC_NS_PLAIN_ONE_LINE_FLOW_KEY})$`, "u");
    var NB_SINGLE_ONE_LINE = new RegExp(`^(?:${SRC_NB_JSON})*$`, "u");
    var NB_SINGLE_MULTI_LINE = new RegExp(`^(?:${SRC_NB_JSON}|\\n)*$`, "u");
    var BLOCK_SCALAR_CONTENT = new RegExp(`^(?:${SRC_NB_CHAR}|\\n)*$`, "u");
    var C_FORBIDDEN_FIRST_LINE = /^(?:---|\.\.\.)(?=$|[ \t\n\r])/;
    var C_FORBIDDEN_CONTENT = /^(?:---|\.\.\.)(?=$|[ \t\n\r])/m;
    function canUsePlain(layout) {
      const str = layout.node.value;
      if (str !== "") {
        if (!(layout.isKey ? layout.flowOnly ? NS_PLAIN_FLOW_KEY : NS_PLAIN_BLOCK_KEY : layout.flowOnly ? NS_PLAIN_FLOW_IN : NS_PLAIN_FLOW_OUT).test(str)) return false;
        if (layout.shiftOfFirstLine === 0 && C_FORBIDDEN_FIRST_LINE.test(str)) return false;
        if (layout.shiftOfContent === 0) {
          const firstLineBreak = str.indexOf("\n");
          if (firstLineBreak !== -1) {
            const content = str.slice(firstLineBreak + 1);
            if (C_FORBIDDEN_CONTENT.test(content)) return false;
          }
        }
      }
      const resolvedTag = layout.presenterOptions.schema.resolveImplicitScalarTag(str).tag.tagName;
      if (!layout.node.tagged && resolvedTag !== layout.node.tag) return false;
      if (!layout.node.tagged && str === "=" && resolvedTag === layout.presenterOptions.schema.defaultScalarTag.tagName) return false;
      return true;
    }
    function canUseSingleQuoted(layout) {
      const str = layout.node.value;
      if (!(layout.isKey ? NB_SINGLE_ONE_LINE : NB_SINGLE_MULTI_LINE).test(str)) return false;
      if (/[ \t]\n|\n[ \t]/.test(str)) return false;
      if (!layout.isKey && layout.shiftOfContent === 0) {
        const firstLineBreak = str.indexOf("\n");
        if (firstLineBreak !== -1 && C_FORBIDDEN_CONTENT.test(str.slice(firstLineBreak + 1))) return false;
      }
      return true;
    }
    function canUseBlock(layout) {
      if (layout.flowOnly || !BLOCK_SCALAR_CONTENT.test(layout.node.value)) return false;
      const contentIndent = layout.shiftOfContent - layout.shiftOfParent;
      if (contentIndent < 1) return false;
      if (contentIndent > 9 && /^\n* /.test(layout.node.value)) return false;
      if (layout.shiftOfContent === 0 && C_FORBIDDEN_CONTENT.test(layout.node.value)) return false;
      return true;
    }
    function detectAllowedStyles(layout) {
      let mask = setBit(0, SCALAR_STYLE.DOUBLE_QUOTED);
      if (canUsePlain(layout)) mask = setBit(mask, SCALAR_STYLE.PLAIN);
      if (canUseSingleQuoted(layout)) mask = setBit(mask, SCALAR_STYLE.SINGLE_QUOTED);
      if (canUseBlock(layout)) mask = setBit(setBit(mask, SCALAR_STYLE.LITERAL_BLOCK), SCALAR_STYLE.FOLDED_BLOCK);
      layout.allowedStylesMask = mask;
    }
    function renderScalar(layout) {
      switch (layout.style) {
        case SCALAR_STYLE.PLAIN:
          return renderPlain(layout);
        case SCALAR_STYLE.SINGLE_QUOTED:
          return renderSingleQuoted(layout);
        case SCALAR_STYLE.LITERAL_BLOCK:
          return renderLiteralBlock(layout);
        case SCALAR_STYLE.FOLDED_BLOCK:
          return renderFoldedBlock(layout);
        case SCALAR_STYLE.DOUBLE_QUOTED:
          return renderDoubleQuoted(layout);
      }
    }
    function renderPlain(layout) {
      return encodeFlowBreaks(layout.node.value, layout.shiftOfContent);
    }
    function renderSingleQuoted(layout) {
      return `'${encodeFlowBreaks(layout.node.value, layout.shiftOfContent).replace(/'/g, "''")}'`;
    }
    function renderLiteralBlock(layout) {
      const value = layout.node.value;
      return "|" + blockHeader(value, layout.shiftOfParent, layout.shiftOfContent) + dropEndingNewline(indentString(value, layout.shiftOfContent));
    }
    function renderFoldedBlock(layout) {
      const value = layout.node.value;
      const w = layout.presenterOptions.lineWidth;
      let availableWidth = Infinity;
      if (w !== -1) availableWidth = Math.max(Math.min(w, 40), w - layout.shiftOfContent);
      return ">" + blockHeader(value, layout.shiftOfParent, layout.shiftOfContent) + dropEndingNewline(indentString(foldBlockScalar(value, availableWidth), layout.shiftOfContent));
    }
    function renderDoubleQuoted(layout) {
      return `"${escapeString(layout.node.value)}"`;
    }
    function encodeFlowBreaks(string, shiftOfContent) {
      let nextLF = string.indexOf("\n");
      if (nextLF === -1) return string;
      const pad = " ".repeat(shiftOfContent);
      let result = string.slice(0, nextLF);
      const lineRe = /(\n+)([^\n]*)/g;
      lineRe.lastIndex = nextLF;
      let match;
      while (match = lineRe.exec(string)) {
        const breaks = match[1].length;
        const line = match[2];
        result += "\n".repeat(breaks + 1) + pad + line;
      }
      return result;
    }
    function indentString(string, spaces) {
      const indent = " ".repeat(spaces);
      let position = 0;
      let result = "";
      const length = string.length;
      while (position < length) {
        let line;
        const next = string.indexOf("\n", position);
        if (next === -1) {
          line = string.slice(position);
          position = length;
        } else {
          line = string.slice(position, next + 1);
          position = next + 1;
        }
        if (line.length && line !== "\n") result += indent;
        result += line;
      }
      return result;
    }
    function needIndentIndicator(string) {
      return /^\n* /.test(string);
    }
    function blockHeader(string, shiftOfParent, shiftOfContent) {
      const indentIndicator = needIndentIndicator(string) ? String(shiftOfContent - shiftOfParent) : "";
      const clip = string[string.length - 1] === "\n";
      return `${indentIndicator}${clip && (string[string.length - 2] === "\n" || string === "\n") ? "+" : clip ? "" : "-"}
`;
    }
    function dropEndingNewline(string) {
      return string[string.length - 1] === "\n" ? string.slice(0, -1) : string;
    }
    function isMoreIndented(char) {
      return char === " " || char === "	";
    }
    function foldLine(line, width) {
      if (line === "" || isMoreIndented(line[0])) return line;
      const breakRe = / [^ \t]/g;
      let match;
      let start = 0;
      let end;
      let curr = 0;
      let next = 0;
      let result = "";
      while (match = breakRe.exec(line)) {
        next = match.index;
        if (next - start > width) {
          end = curr > start ? curr : next;
          result += `
${line.slice(start, end)}`;
          start = end + 1;
        }
        curr = next;
      }
      result += "\n";
      if (line.length - start > width && curr > start) result += `${line.slice(start, curr)}
${line.slice(curr + 1)}`;
      else result += line.slice(start);
      return result.slice(1);
    }
    function foldBlockScalar(string, width) {
      const lineRe = /(\n+)([^\n]*)/g;
      let nextLF = string.indexOf("\n");
      if (nextLF === -1) nextLF = string.length;
      lineRe.lastIndex = nextLF;
      let result = foldLine(string.slice(0, nextLF), width);
      let prevMoreIndented = string[0] === "\n" || isMoreIndented(string[0]);
      let moreIndented;
      let match;
      while (match = lineRe.exec(string)) {
        const prefix = match[1];
        const line = match[2];
        moreIndented = line !== "" && isMoreIndented(line[0]);
        result += prefix + (!prevMoreIndented && !moreIndented && line !== "" ? "\n" : "") + foldLine(line, width);
        prevMoreIndented = moreIndented;
      }
      return result;
    }
    var CHARACTERS_TO_ESCAPE = /["\\\x00-\x1F\x7F-\xA0\u2028\u2029\uD800-\uDFFF\uFEFF\uFFFE\uFFFF]/gu;
    function escapeCharacter(character) {
      switch (character) {
        case "\0":
          return "\\0";
        case "\x07":
          return "\\a";
        case "\b":
          return "\\b";
        case "	":
          return "\\t";
        case "\n":
          return "\\n";
        case "\v":
          return "\\v";
        case "\f":
          return "\\f";
        case "\r":
          return "\\r";
        case "\x1B":
          return "\\e";
        case '"':
          return '\\"';
        case "\\":
          return "\\\\";
        case "\x85":
          return "\\N";
        case "\xA0":
          return "\\_";
        case "\u2028":
          return "\\L";
        case "\u2029":
          return "\\P";
      }
      const code = character.charCodeAt(0);
      const hex = code.toString(16).toUpperCase();
      if (code <= 255) return `\\x${"0".repeat(2 - hex.length)}${hex}`;
      return `\\u${"0".repeat(4 - hex.length)}${hex}`;
    }
    function escapeString(string) {
      return string.replace(CHARACTERS_TO_ESCAPE, escapeCharacter);
    }
    var CHAR_LINE_FEED = 10;
    var DEFAULT_PRESENTER_OPTIONS = {
      indent: 2,
      seqNoIndent: false,
      seqInlineFirst: true,
      lineWidth: 80,
      flowBracketPadding: false,
      flowSkipCommaSpace: false,
      flowSkipColonSpace: false,
      quoteFlowKeys: false,
      quoteStyle: "single",
      forceQuotes: false,
      scalarStyleRules: Object.keys(DEFAULT_SCALAR_STYLE_RULES).map((name) => Reflect.get(DEFAULT_SCALAR_STYLE_RULES, name)),
      tagBeforeAnchor: false
    };
    function nodeTagShort(node) {
      return node.tagged ? node.tag : tagNameShort(node.tag);
    }
    function createPresenterState(options) {
      const opts = _objectSpread2(_objectSpread2({}, DEFAULT_PRESENTER_OPTIONS), options);
      if (opts.flowSkipColonSpace) opts.quoteFlowKeys = true;
      return _objectSpread2(_objectSpread2({}, opts), {}, {
        defaultScalarTagName: opts.schema.defaultScalarTag.tagName,
        openEnded: false
      });
    }
    function generateNextLine(state, level) {
      return `
${" ".repeat(state.indent * level)}`;
    }
    function scalarLayout(state, node, parent, level, isKey, flowOnly) {
      return {
        node,
        parent,
        level,
        isKey,
        flowOnly,
        shiftOfParent: level === 0 ? -1 : state.indent * (level - 1),
        shiftOfContent: state.indent * Math.max(1, level),
        shiftOfFirstLine: level === 0 ? 0 : state.indent * level,
        presenterOptions: state,
        allowedStylesMask: 0,
        style: node.style
      };
    }
    function writeFlowSequence(state, level, node) {
      let result = "";
      for (let index = 0, length = node.items.length; index < length; index += 1) {
        const item = writeNode(state, level, node.items[index], node, {}).text;
        if (index > 0) result += `,${!state.flowSkipCommaSpace ? " " : ""}`;
        result += item;
      }
      const pad = state.flowBracketPadding && node.items.length > 0 ? " " : "";
      return `[${pad}${result}${pad}]`;
    }
    function writeBlockSequence(state, level, node, compact) {
      let result = "";
      for (let index = 0, length = node.items.length; index < length; index += 1) {
        const item = writeNode(state, level + 1, node.items[index], node, {
          block: true,
          compact: state.seqInlineFirst,
          isblockseq: true
        }).text;
        if (!compact || result !== "") result += generateNextLine(state, level);
        if (item === "" || CHAR_LINE_FEED === item.charCodeAt(0)) result += "-";
        else result += "- ";
        result += item;
      }
      return result;
    }
    function writeFlowMapping(state, level, node) {
      let result = "";
      for (const { key, value } of node.items) {
        let pairBuffer = "";
        if (result !== "") pairBuffer += `,${!state.flowSkipCommaSpace ? " " : ""}`;
        const keyRender = writeNode(state, level, key, node, { iskey: true });
        const keyText = keyRender.text;
        const valueText = writeNode(state, level, value, node, {}).text;
        const sep = state.flowSkipColonSpace || valueText === "" ? "" : " ";
        const keyIsBareProps = key.kind === "scalar" && keyRender.noBody && (key.tagged || key.anchor !== void 0);
        const keyColonSep = key.kind === "alias" || keyIsBareProps ? " " : "";
        pairBuffer += `${keyText}${keyColonSep}:${sep}${valueText}`;
        result += pairBuffer;
      }
      const pad = state.flowBracketPadding && result !== "" ? " " : "";
      return `{${pad}${result}${pad}}`;
    }
    function writeBlockMapping(state, level, node, compact) {
      let result = "";
      for (let index = 0, length = node.items.length; index < length; index += 1) {
        let pairBuffer = "";
        if (!compact || result !== "") pairBuffer += generateNextLine(state, level);
        const { key, value } = node.items[index];
        const keyIsBlock = (key.kind === "mapping" || key.kind === "sequence") && key.style === COLLECTION_STYLE.BLOCK && key.items.length !== 0 || key.kind === "scalar" && (key.style === SCALAR_STYLE.LITERAL_BLOCK || key.style === SCALAR_STYLE.FOLDED_BLOCK);
        const keyRender = keyIsBlock ? writeNode(state, level + 1, key, node, {
          block: true,
          compact: true,
          isblockseq: !cannotBeCompact(state, key, level + 1)
        }) : writeNode(state, level + 1, key, node, {
          block: true,
          compact: true,
          iskey: true
        });
        const keyText = keyRender.text;
        const keyHasLineBreak = key.kind === "scalar" && key.value.indexOf("\n") !== -1;
        const keyIsTooLong = keyText.length > 1024 && /^[\s\S]{1025}/u.test(keyText);
        const explicitPair = keyIsBlock || keyHasLineBreak || keyIsTooLong;
        if (explicitPair) if (keyText && CHAR_LINE_FEED === keyText.charCodeAt(0)) pairBuffer += "?";
        else pairBuffer += "? ";
        pairBuffer += keyText;
        if (explicitPair) pairBuffer += generateNextLine(state, level);
        const valueText = writeNode(state, level + 1, value, node, {
          block: true,
          compact: explicitPair,
          isblockseq: explicitPair && !cannotBeCompact(state, value, level + 1)
        }).text;
        const keyIsBareProps = key.kind === "scalar" && keyRender.noBody && (key.tagged || key.anchor !== void 0);
        const keyColonSep = !explicitPair && (key.kind === "alias" || keyIsBareProps) ? " " : "";
        if (valueText === "" || CHAR_LINE_FEED === valueText.charCodeAt(0)) pairBuffer += `${keyColonSep}:`;
        else pairBuffer += `${keyColonSep}: `;
        pairBuffer += valueText;
        result += pairBuffer;
      }
      return result;
    }
    function cannotBeCompact(state, node, level) {
      if (node.kind === "alias") return true;
      return node.tagged || node.anchor !== void 0 || state.indent < 2 && level > 0;
    }
    function writeNode(state, level, node, parent, ctx) {
      var _ctx$compact;
      if (node.kind === "alias") {
        state.openEnded = false;
        return {
          text: `*${node.anchor}`,
          noBody: false
        };
      }
      const { block = false, iskey = false, isblockseq = false } = ctx;
      let compact = (_ctx$compact = ctx.compact) !== null && _ctx$compact !== void 0 ? _ctx$compact : false;
      const hasAnchor = node.anchor !== void 0;
      if (cannotBeCompact(state, node, level)) compact = false;
      let body;
      let shouldPrintTag = node.tagged;
      const useBlockCollection = block && (node.kind === "mapping" || node.kind === "sequence") && node.style === COLLECTION_STYLE.BLOCK && node.items.length !== 0;
      if (node.kind === "mapping") if (useBlockCollection) body = writeBlockMapping(state, level, node, compact);
      else body = writeFlowMapping(state, level, node);
      else if (node.kind === "sequence") if (useBlockCollection) if (state.seqNoIndent && !isblockseq && level > 0) body = writeBlockSequence(state, level - 1, node, compact);
      else body = writeBlockSequence(state, level, node, compact);
      else body = writeFlowSequence(state, level, node);
      else {
        const layout = scalarLayout(state, node, parent, level, iskey, !block);
        detectAllowedStyles(layout);
        for (const rule of state.scalarStyleRules) rule(layout);
        body = renderScalar(layout);
        state.openEnded = (layout.style === SCALAR_STYLE.LITERAL_BLOCK || layout.style === SCALAR_STYLE.FOLDED_BLOCK) && (node.value === "\n" || node.value.endsWith("\n\n"));
        shouldPrintTag = node.tagged || body === "" && layout.flowOnly && (parent === null || parent === void 0 ? void 0 : parent.kind) === "sequence" && !hasAnchor || layout.style !== SCALAR_STYLE.PLAIN && node.tag !== state.defaultScalarTagName;
      }
      if ((node.kind === "mapping" || node.kind === "sequence") && !useBlockCollection) state.openEnded = false;
      if (useBlockCollection && compact && level > 0 && state.indent > 2) body = `${" ".repeat(state.indent - 2)}${body}`;
      const noBody = body === "";
      let text = body;
      if (shouldPrintTag || hasAnchor) {
        const props = [];
        const tag = shouldPrintTag ? nodeTagShort(node) : null;
        const anchor = hasAnchor ? `&${node.anchor}` : null;
        if (state.tagBeforeAnchor) {
          if (tag !== null) props.push(tag);
          if (anchor !== null) props.push(anchor);
        } else {
          if (anchor !== null) props.push(anchor);
          if (tag !== null) props.push(tag);
        }
        const sep = body === "" || body.charCodeAt(0) === CHAR_LINE_FEED ? "" : " ";
        text = `${props.join(" ")}${sep}${body}`;
      }
      return {
        text,
        noBody
      };
    }
    function rootStartsOwnLine(node) {
      return (node.kind === "sequence" || node.kind === "mapping") && node.style === COLLECTION_STYLE.BLOCK && node.items.length !== 0 && !node.tagged && node.anchor === void 0;
    }
    function writeDocumentDirectives(doc) {
      let result = "";
      for (const directive of doc.directives) {
        if (directive.kind === "yaml") {
          result += `%YAML ${directive.version}
`;
          continue;
        }
        const { handle, prefix } = directive;
        result += `%TAG ${handle} ${prefix}
`;
      }
      return result;
    }
    function present(documents, options) {
      const state = createPresenterState(options);
      let result = "";
      let previousEnded = false;
      for (let index = 0; index < documents.length; index += 1) {
        const doc = documents[index];
        state.openEnded = false;
        const directives = writeDocumentDirectives(doc);
        const hasDirectives = directives !== "";
        const marker = doc.explicitStart || hasDirectives || index > 0 && !previousEnded;
        result += directives;
        if (doc.contents === null) {
          if (marker) result += "---\n";
        } else if (marker) {
          const body = writeNode(state, 0, doc.contents, null, {
            block: true,
            compact: true
          }).text;
          const sep = body === "" ? "" : hasDirectives || rootStartsOwnLine(doc.contents) ? "\n" : " ";
          result += `---${sep}${body}
`;
        } else result += writeNode(state, 0, doc.contents, null, {
          block: true,
          compact: true
        }).text + "\n";
        previousEnded = doc.explicitEnd || state.openEnded;
        if (previousEnded) result += "...\n";
      }
      return result;
    }
    var DEFAULT_DUMP_OPTIONS = _objectSpread2(_objectSpread2({}, DEFAULT_PRESENTER_OPTIONS), {}, {
      schema: DUMP_SCHEMA,
      skipInvalid: false,
      noRefs: false,
      flowLevel: -1,
      sortKeys: false,
      transform: () => {
      }
    });
    function defaultCompareFn(a, b) {
      const x = String(a);
      const y = String(b);
      if (x < y) return -1;
      if (x > y) return 1;
      return 0;
    }
    function dump(input, options = {}) {
      const opts = _objectSpread2(_objectSpread2({}, DEFAULT_DUMP_OPTIONS), options);
      const documents = jsToAst(input, opts.schema, {
        noRefs: opts.noRefs,
        skipInvalid: opts.skipInvalid
      });
      if (opts.flowLevel >= 0) visit(documents, (node, ctx) => {
        if (ctx.depth < opts.flowLevel) return;
        if (node.kind === "sequence" || node.kind === "mapping") node.style = COLLECTION_STYLE.FLOW;
        return VISIT_SKIP;
      });
      if (opts.sortKeys) {
        const compareFn = opts.sortKeys === true ? defaultCompareFn : opts.sortKeys;
        visit(documents, (node) => {
          if (node.kind !== "mapping") return;
          node.items.sort((a, b) => compareFn(a.key.kind === "scalar" ? a.key.value : "", b.key.kind === "scalar" ? b.key.value : ""));
        });
      }
      opts.transform(documents);
      return present(documents, _objectSpread2(_objectSpread2({}, pick(opts, Object.keys(DEFAULT_PRESENTER_OPTIONS))), {}, { schema: opts.schema }));
    }
    var NO_RANGE = -1;
    function eventPosition(event) {
      if ("tagStart" in event && event.tagStart !== NO_RANGE) return event.tagStart;
      if ("anchorStart" in event && event.anchorStart !== NO_RANGE) return event.anchorStart;
      if ("valueStart" in event && event.valueStart !== NO_RANGE) return event.valueStart;
      if ("start" in event) return event.start;
      return 0;
    }
    function rawTag(state, event) {
      return event.tagStart === NO_RANGE ? "" : state.source.slice(event.tagStart, event.tagEnd);
    }
    function anchorName(state, event) {
      return event.anchorStart === NO_RANGE ? void 0 : state.source.slice(event.anchorStart, event.anchorEnd);
    }
    function buildScalar(state, event) {
      const value = getScalarValue(state.source, event);
      const raw = rawTag(state, event);
      let tag;
      let tagged = false;
      if (raw !== "") {
        tagged = true;
        tag = raw;
      } else if (event.style === SCALAR_STYLE.PLAIN) tag = state.schema.resolveImplicitScalarTag(value).tag.tagName;
      else tag = state.schema.defaultScalarTag.tagName;
      return {
        kind: "scalar",
        tag,
        tagged,
        style: event.style,
        anchor: anchorName(state, event),
        value
      };
    }
    function buildCollection(state, event, defaultTagName) {
      const raw = rawTag(state, event);
      let tag;
      let tagged = false;
      if (raw === "") tag = defaultTagName;
      else {
        tag = raw;
        tagged = true;
      }
      return {
        tag,
        tagged,
        style: event.style,
        anchor: anchorName(state, event)
      };
    }
    function addNode(state, node) {
      const frame = state.frames[state.frames.length - 1];
      if (frame.kind === "document") frame.doc.contents = node;
      else if (frame.kind === "sequence") frame.node.items.push(node);
      else if (frame.key) {
        frame.node.items.push({
          key: frame.key,
          value: node
        });
        frame.key = null;
      } else frame.key = node;
    }
    function eventsToAst(events, options) {
      const state = {
        source: options.source,
        schema: options.schema,
        eventIndex: 0,
        position: 0,
        frames: [],
        documents: []
      };
      while (state.eventIndex < events.length) {
        const event = events[state.eventIndex++];
        state.position = eventPosition(event);
        switch (event.type) {
          case EVENT_ID.DOCUMENT: {
            const doc = {
              contents: null,
              explicitStart: event.explicitStart,
              explicitEnd: event.explicitEnd,
              directives: event.directives
            };
            state.frames.push({
              kind: "document",
              doc
            });
            break;
          }
          case EVENT_ID.SCALAR:
            addNode(state, buildScalar(state, event));
            break;
          case EVENT_ID.SEQUENCE: {
            const { tag, tagged, style, anchor } = buildCollection(state, event, "tag:yaml.org,2002:seq");
            const node = {
              kind: "sequence",
              tag,
              tagged,
              style,
              anchor,
              items: []
            };
            state.frames.push({
              kind: "sequence",
              node
            });
            break;
          }
          case EVENT_ID.MAPPING: {
            const { tag, tagged, style, anchor } = buildCollection(state, event, "tag:yaml.org,2002:map");
            const node = {
              kind: "mapping",
              tag,
              tagged,
              style,
              anchor,
              items: []
            };
            state.frames.push({
              kind: "mapping",
              node,
              key: null
            });
            break;
          }
          case EVENT_ID.ALIAS:
            addNode(state, {
              kind: "alias",
              anchor: state.source.slice(event.anchorStart, event.anchorEnd)
            });
            break;
          case EVENT_ID.POP: {
            const frame = state.frames.pop();
            if (frame.kind === "mapping" && frame.key) throw new Error("incomplete mapping pair in event stream");
            if (frame.kind === "document") state.documents.push(frame.doc);
            else addNode(state, frame.node);
            break;
          }
        }
      }
      return state.documents;
    }
    var EVENT_DOCUMENT = EVENT_ID.DOCUMENT;
    var EVENT_SEQUENCE = EVENT_ID.SEQUENCE;
    var EVENT_MAPPING = EVENT_ID.MAPPING;
    var EVENT_SCALAR = EVENT_ID.SCALAR;
    var EVENT_ALIAS = EVENT_ID.ALIAS;
    var EVENT_POP = EVENT_ID.POP;
    var SCALAR_STYLE_PLAIN = SCALAR_STYLE.PLAIN;
    var SCALAR_STYLE_SINGLE_QUOTED = SCALAR_STYLE.SINGLE_QUOTED;
    var SCALAR_STYLE_DOUBLE_QUOTED = SCALAR_STYLE.DOUBLE_QUOTED;
    var SCALAR_STYLE_LITERAL_BLOCK = SCALAR_STYLE.LITERAL_BLOCK;
    var SCALAR_STYLE_FOLDED_BLOCK = SCALAR_STYLE.FOLDED_BLOCK;
    var COLLECTION_STYLE_BLOCK = COLLECTION_STYLE.BLOCK;
    var COLLECTION_STYLE_FLOW = COLLECTION_STYLE.FLOW;
    var CHOMPING_CLIP = CHOMPING_MODE.CLIP;
    var CHOMPING_STRIP = CHOMPING_MODE.STRIP;
    var CHOMPING_KEEP = CHOMPING_MODE.KEEP;
    exports2.CHOMPING_CLIP = CHOMPING_CLIP;
    exports2.CHOMPING_KEEP = CHOMPING_KEEP;
    exports2.CHOMPING_MODE = CHOMPING_MODE;
    exports2.CHOMPING_STRIP = CHOMPING_STRIP;
    exports2.COLLECTION_STYLE = COLLECTION_STYLE;
    exports2.COLLECTION_STYLE_BLOCK = COLLECTION_STYLE_BLOCK;
    exports2.COLLECTION_STYLE_FLOW = COLLECTION_STYLE_FLOW;
    exports2.CORE_SCHEMA = CORE_SCHEMA;
    exports2.DEFAULT_SCALAR_STYLE_RULES = DEFAULT_SCALAR_STYLE_RULES;
    exports2.DUMP_SCHEMA = DUMP_SCHEMA;
    exports2.EVENT_ALIAS = EVENT_ALIAS;
    exports2.EVENT_DOCUMENT = EVENT_DOCUMENT;
    exports2.EVENT_ID = EVENT_ID;
    exports2.EVENT_MAPPING = EVENT_MAPPING;
    exports2.EVENT_POP = EVENT_POP;
    exports2.EVENT_SCALAR = EVENT_SCALAR;
    exports2.EVENT_SEQUENCE = EVENT_SEQUENCE;
    exports2.FAILSAFE_SCHEMA = FAILSAFE_SCHEMA;
    exports2.JSON_SCHEMA = JSON_SCHEMA;
    exports2.NOT_RESOLVED = NOT_RESOLVED;
    exports2.SCALAR_STYLE = SCALAR_STYLE;
    exports2.SCALAR_STYLE_DOUBLE_QUOTED = SCALAR_STYLE_DOUBLE_QUOTED;
    exports2.SCALAR_STYLE_FOLDED_BLOCK = SCALAR_STYLE_FOLDED_BLOCK;
    exports2.SCALAR_STYLE_LITERAL_BLOCK = SCALAR_STYLE_LITERAL_BLOCK;
    exports2.SCALAR_STYLE_PLAIN = SCALAR_STYLE_PLAIN;
    exports2.SCALAR_STYLE_SINGLE_QUOTED = SCALAR_STYLE_SINGLE_QUOTED;
    exports2.Schema = Schema;
    exports2.VISIT_BREAK = VISIT_BREAK;
    exports2.VISIT_SKIP = VISIT_SKIP;
    exports2.YAML11_SCHEMA = YAML11_SCHEMA;
    exports2.YAMLException = YAMLException;
    exports2.binaryTag = binaryTag;
    exports2.boolCoreTag = boolCoreTag;
    exports2.boolJsonTag = boolJsonTag;
    exports2.boolYaml11Tag = boolYaml11Tag;
    exports2.constructFromEvents = constructFromEvents;
    exports2.defineMappingTag = defineMappingTag;
    exports2.defineScalarTag = defineScalarTag;
    exports2.defineSequenceTag = defineSequenceTag;
    exports2.dump = dump;
    exports2.eventsToAst = eventsToAst;
    exports2.floatCoreTag = floatCoreTag;
    exports2.floatJsonTag = floatJsonTag;
    exports2.floatYaml11Tag = floatYaml11Tag;
    exports2.getScalarValue = getScalarValue;
    exports2.intCoreTag = intCoreTag;
    exports2.intJsonTag = intJsonTag;
    exports2.intYaml11Tag = intYaml11Tag;
    exports2.jsToAst = jsToAst;
    exports2.legacyMapTag = legacyMapTag;
    exports2.load = load;
    exports2.loadAll = loadAll;
    exports2.mapTag = mapTag;
    exports2.mergeTag = mergeTag;
    exports2.nullCoreTag = nullCoreTag;
    exports2.nullJsonTag = nullJsonTag;
    exports2.nullYaml11Tag = nullYaml11Tag;
    exports2.omapTag = omapTag;
    exports2.pairsTag = pairsTag;
    exports2.parseEvents = parseEvents;
    exports2.present = present;
    exports2.realMapTag = realMapTag;
    exports2.seqTag = seqTag;
    exports2.setTag = setTag;
    exports2.strTag = strTag;
    exports2.timestampTag = timestampTag;
    exports2.visit = visit;
  }
});

// node_modules/.pnpm/lazy-val@1.0.5/node_modules/lazy-val/out/main.js
var require_main = __commonJS({
  "node_modules/.pnpm/lazy-val@1.0.5/node_modules/lazy-val/out/main.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.Lazy = void 0;
    var Lazy = class {
      constructor(creator) {
        this._value = null;
        this.creator = creator;
      }
      get hasValue() {
        return this.creator == null;
      }
      get value() {
        if (this.creator == null) {
          return this._value;
        }
        const result = this.creator();
        this.value = result;
        return result;
      }
      set value(value) {
        this._value = value;
        this.creator = null;
      }
    };
    exports2.Lazy = Lazy;
  }
});

// node_modules/.pnpm/semver@7.7.4/node_modules/semver/internal/constants.js
var require_constants = __commonJS({
  "node_modules/.pnpm/semver@7.7.4/node_modules/semver/internal/constants.js"(exports2, module2) {
    "use strict";
    var SEMVER_SPEC_VERSION = "2.0.0";
    var MAX_LENGTH = 256;
    var MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER || /* istanbul ignore next */
    9007199254740991;
    var MAX_SAFE_COMPONENT_LENGTH = 16;
    var MAX_SAFE_BUILD_LENGTH = MAX_LENGTH - 6;
    var RELEASE_TYPES = [
      "major",
      "premajor",
      "minor",
      "preminor",
      "patch",
      "prepatch",
      "prerelease"
    ];
    module2.exports = {
      MAX_LENGTH,
      MAX_SAFE_COMPONENT_LENGTH,
      MAX_SAFE_BUILD_LENGTH,
      MAX_SAFE_INTEGER,
      RELEASE_TYPES,
      SEMVER_SPEC_VERSION,
      FLAG_INCLUDE_PRERELEASE: 1,
      FLAG_LOOSE: 2
    };
  }
});

// node_modules/.pnpm/semver@7.7.4/node_modules/semver/internal/debug.js
var require_debug = __commonJS({
  "node_modules/.pnpm/semver@7.7.4/node_modules/semver/internal/debug.js"(exports2, module2) {
    "use strict";
    var debug = typeof process === "object" && process.env && process.env.NODE_DEBUG && /\bsemver\b/i.test(process.env.NODE_DEBUG) ? (...args) => console.error("SEMVER", ...args) : () => {
    };
    module2.exports = debug;
  }
});

// node_modules/.pnpm/semver@7.7.4/node_modules/semver/internal/re.js
var require_re = __commonJS({
  "node_modules/.pnpm/semver@7.7.4/node_modules/semver/internal/re.js"(exports2, module2) {
    "use strict";
    var {
      MAX_SAFE_COMPONENT_LENGTH,
      MAX_SAFE_BUILD_LENGTH,
      MAX_LENGTH
    } = require_constants();
    var debug = require_debug();
    exports2 = module2.exports = {};
    var re = exports2.re = [];
    var safeRe = exports2.safeRe = [];
    var src = exports2.src = [];
    var safeSrc = exports2.safeSrc = [];
    var t = exports2.t = {};
    var R = 0;
    var LETTERDASHNUMBER = "[a-zA-Z0-9-]";
    var safeRegexReplacements = [
      ["\\s", 1],
      ["\\d", MAX_LENGTH],
      [LETTERDASHNUMBER, MAX_SAFE_BUILD_LENGTH]
    ];
    var makeSafeRegex = (value) => {
      for (const [token, max] of safeRegexReplacements) {
        value = value.split(`${token}*`).join(`${token}{0,${max}}`).split(`${token}+`).join(`${token}{1,${max}}`);
      }
      return value;
    };
    var createToken = (name, value, isGlobal) => {
      const safe = makeSafeRegex(value);
      const index = R++;
      debug(name, index, value);
      t[name] = index;
      src[index] = value;
      safeSrc[index] = safe;
      re[index] = new RegExp(value, isGlobal ? "g" : void 0);
      safeRe[index] = new RegExp(safe, isGlobal ? "g" : void 0);
    };
    createToken("NUMERICIDENTIFIER", "0|[1-9]\\d*");
    createToken("NUMERICIDENTIFIERLOOSE", "\\d+");
    createToken("NONNUMERICIDENTIFIER", `\\d*[a-zA-Z-]${LETTERDASHNUMBER}*`);
    createToken("MAINVERSION", `(${src[t.NUMERICIDENTIFIER]})\\.(${src[t.NUMERICIDENTIFIER]})\\.(${src[t.NUMERICIDENTIFIER]})`);
    createToken("MAINVERSIONLOOSE", `(${src[t.NUMERICIDENTIFIERLOOSE]})\\.(${src[t.NUMERICIDENTIFIERLOOSE]})\\.(${src[t.NUMERICIDENTIFIERLOOSE]})`);
    createToken("PRERELEASEIDENTIFIER", `(?:${src[t.NONNUMERICIDENTIFIER]}|${src[t.NUMERICIDENTIFIER]})`);
    createToken("PRERELEASEIDENTIFIERLOOSE", `(?:${src[t.NONNUMERICIDENTIFIER]}|${src[t.NUMERICIDENTIFIERLOOSE]})`);
    createToken("PRERELEASE", `(?:-(${src[t.PRERELEASEIDENTIFIER]}(?:\\.${src[t.PRERELEASEIDENTIFIER]})*))`);
    createToken("PRERELEASELOOSE", `(?:-?(${src[t.PRERELEASEIDENTIFIERLOOSE]}(?:\\.${src[t.PRERELEASEIDENTIFIERLOOSE]})*))`);
    createToken("BUILDIDENTIFIER", `${LETTERDASHNUMBER}+`);
    createToken("BUILD", `(?:\\+(${src[t.BUILDIDENTIFIER]}(?:\\.${src[t.BUILDIDENTIFIER]})*))`);
    createToken("FULLPLAIN", `v?${src[t.MAINVERSION]}${src[t.PRERELEASE]}?${src[t.BUILD]}?`);
    createToken("FULL", `^${src[t.FULLPLAIN]}$`);
    createToken("LOOSEPLAIN", `[v=\\s]*${src[t.MAINVERSIONLOOSE]}${src[t.PRERELEASELOOSE]}?${src[t.BUILD]}?`);
    createToken("LOOSE", `^${src[t.LOOSEPLAIN]}$`);
    createToken("GTLT", "((?:<|>)?=?)");
    createToken("XRANGEIDENTIFIERLOOSE", `${src[t.NUMERICIDENTIFIERLOOSE]}|x|X|\\*`);
    createToken("XRANGEIDENTIFIER", `${src[t.NUMERICIDENTIFIER]}|x|X|\\*`);
    createToken("XRANGEPLAIN", `[v=\\s]*(${src[t.XRANGEIDENTIFIER]})(?:\\.(${src[t.XRANGEIDENTIFIER]})(?:\\.(${src[t.XRANGEIDENTIFIER]})(?:${src[t.PRERELEASE]})?${src[t.BUILD]}?)?)?`);
    createToken("XRANGEPLAINLOOSE", `[v=\\s]*(${src[t.XRANGEIDENTIFIERLOOSE]})(?:\\.(${src[t.XRANGEIDENTIFIERLOOSE]})(?:\\.(${src[t.XRANGEIDENTIFIERLOOSE]})(?:${src[t.PRERELEASELOOSE]})?${src[t.BUILD]}?)?)?`);
    createToken("XRANGE", `^${src[t.GTLT]}\\s*${src[t.XRANGEPLAIN]}$`);
    createToken("XRANGELOOSE", `^${src[t.GTLT]}\\s*${src[t.XRANGEPLAINLOOSE]}$`);
    createToken("COERCEPLAIN", `${"(^|[^\\d])(\\d{1,"}${MAX_SAFE_COMPONENT_LENGTH}})(?:\\.(\\d{1,${MAX_SAFE_COMPONENT_LENGTH}}))?(?:\\.(\\d{1,${MAX_SAFE_COMPONENT_LENGTH}}))?`);
    createToken("COERCE", `${src[t.COERCEPLAIN]}(?:$|[^\\d])`);
    createToken("COERCEFULL", src[t.COERCEPLAIN] + `(?:${src[t.PRERELEASE]})?(?:${src[t.BUILD]})?(?:$|[^\\d])`);
    createToken("COERCERTL", src[t.COERCE], true);
    createToken("COERCERTLFULL", src[t.COERCEFULL], true);
    createToken("LONETILDE", "(?:~>?)");
    createToken("TILDETRIM", `(\\s*)${src[t.LONETILDE]}\\s+`, true);
    exports2.tildeTrimReplace = "$1~";
    createToken("TILDE", `^${src[t.LONETILDE]}${src[t.XRANGEPLAIN]}$`);
    createToken("TILDELOOSE", `^${src[t.LONETILDE]}${src[t.XRANGEPLAINLOOSE]}$`);
    createToken("LONECARET", "(?:\\^)");
    createToken("CARETTRIM", `(\\s*)${src[t.LONECARET]}\\s+`, true);
    exports2.caretTrimReplace = "$1^";
    createToken("CARET", `^${src[t.LONECARET]}${src[t.XRANGEPLAIN]}$`);
    createToken("CARETLOOSE", `^${src[t.LONECARET]}${src[t.XRANGEPLAINLOOSE]}$`);
    createToken("COMPARATORLOOSE", `^${src[t.GTLT]}\\s*(${src[t.LOOSEPLAIN]})$|^$`);
    createToken("COMPARATOR", `^${src[t.GTLT]}\\s*(${src[t.FULLPLAIN]})$|^$`);
    createToken("COMPARATORTRIM", `(\\s*)${src[t.GTLT]}\\s*(${src[t.LOOSEPLAIN]}|${src[t.XRANGEPLAIN]})`, true);
    exports2.comparatorTrimReplace = "$1$2$3";
    createToken("HYPHENRANGE", `^\\s*(${src[t.XRANGEPLAIN]})\\s+-\\s+(${src[t.XRANGEPLAIN]})\\s*$`);
    createToken("HYPHENRANGELOOSE", `^\\s*(${src[t.XRANGEPLAINLOOSE]})\\s+-\\s+(${src[t.XRANGEPLAINLOOSE]})\\s*$`);
    createToken("STAR", "(<|>)?=?\\s*\\*");
    createToken("GTE0", "^\\s*>=\\s*0\\.0\\.0\\s*$");
    createToken("GTE0PRE", "^\\s*>=\\s*0\\.0\\.0-0\\s*$");
  }
});

// node_modules/.pnpm/semver@7.7.4/node_modules/semver/internal/parse-options.js
var require_parse_options = __commonJS({
  "node_modules/.pnpm/semver@7.7.4/node_modules/semver/internal/parse-options.js"(exports2, module2) {
    "use strict";
    var looseOption = Object.freeze({ loose: true });
    var emptyOpts = Object.freeze({});
    var parseOptions = (options) => {
      if (!options) {
        return emptyOpts;
      }
      if (typeof options !== "object") {
        return looseOption;
      }
      return options;
    };
    module2.exports = parseOptions;
  }
});

// node_modules/.pnpm/semver@7.7.4/node_modules/semver/internal/identifiers.js
var require_identifiers = __commonJS({
  "node_modules/.pnpm/semver@7.7.4/node_modules/semver/internal/identifiers.js"(exports2, module2) {
    "use strict";
    var numeric = /^[0-9]+$/;
    var compareIdentifiers = (a, b) => {
      if (typeof a === "number" && typeof b === "number") {
        return a === b ? 0 : a < b ? -1 : 1;
      }
      const anum = numeric.test(a);
      const bnum = numeric.test(b);
      if (anum && bnum) {
        a = +a;
        b = +b;
      }
      return a === b ? 0 : anum && !bnum ? -1 : bnum && !anum ? 1 : a < b ? -1 : 1;
    };
    var rcompareIdentifiers = (a, b) => compareIdentifiers(b, a);
    module2.exports = {
      compareIdentifiers,
      rcompareIdentifiers
    };
  }
});

// node_modules/.pnpm/semver@7.7.4/node_modules/semver/classes/semver.js
var require_semver = __commonJS({
  "node_modules/.pnpm/semver@7.7.4/node_modules/semver/classes/semver.js"(exports2, module2) {
    "use strict";
    var debug = require_debug();
    var { MAX_LENGTH, MAX_SAFE_INTEGER } = require_constants();
    var { safeRe: re, t } = require_re();
    var parseOptions = require_parse_options();
    var { compareIdentifiers } = require_identifiers();
    var SemVer = class _SemVer {
      constructor(version, options) {
        options = parseOptions(options);
        if (version instanceof _SemVer) {
          if (version.loose === !!options.loose && version.includePrerelease === !!options.includePrerelease) {
            return version;
          } else {
            version = version.version;
          }
        } else if (typeof version !== "string") {
          throw new TypeError(`Invalid version. Must be a string. Got type "${typeof version}".`);
        }
        if (version.length > MAX_LENGTH) {
          throw new TypeError(
            `version is longer than ${MAX_LENGTH} characters`
          );
        }
        debug("SemVer", version, options);
        this.options = options;
        this.loose = !!options.loose;
        this.includePrerelease = !!options.includePrerelease;
        const m = version.trim().match(options.loose ? re[t.LOOSE] : re[t.FULL]);
        if (!m) {
          throw new TypeError(`Invalid Version: ${version}`);
        }
        this.raw = version;
        this.major = +m[1];
        this.minor = +m[2];
        this.patch = +m[3];
        if (this.major > MAX_SAFE_INTEGER || this.major < 0) {
          throw new TypeError("Invalid major version");
        }
        if (this.minor > MAX_SAFE_INTEGER || this.minor < 0) {
          throw new TypeError("Invalid minor version");
        }
        if (this.patch > MAX_SAFE_INTEGER || this.patch < 0) {
          throw new TypeError("Invalid patch version");
        }
        if (!m[4]) {
          this.prerelease = [];
        } else {
          this.prerelease = m[4].split(".").map((id) => {
            if (/^[0-9]+$/.test(id)) {
              const num = +id;
              if (num >= 0 && num < MAX_SAFE_INTEGER) {
                return num;
              }
            }
            return id;
          });
        }
        this.build = m[5] ? m[5].split(".") : [];
        this.format();
      }
      format() {
        this.version = `${this.major}.${this.minor}.${this.patch}`;
        if (this.prerelease.length) {
          this.version += `-${this.prerelease.join(".")}`;
        }
        return this.version;
      }
      toString() {
        return this.version;
      }
      compare(other) {
        debug("SemVer.compare", this.version, this.options, other);
        if (!(other instanceof _SemVer)) {
          if (typeof other === "string" && other === this.version) {
            return 0;
          }
          other = new _SemVer(other, this.options);
        }
        if (other.version === this.version) {
          return 0;
        }
        return this.compareMain(other) || this.comparePre(other);
      }
      compareMain(other) {
        if (!(other instanceof _SemVer)) {
          other = new _SemVer(other, this.options);
        }
        if (this.major < other.major) {
          return -1;
        }
        if (this.major > other.major) {
          return 1;
        }
        if (this.minor < other.minor) {
          return -1;
        }
        if (this.minor > other.minor) {
          return 1;
        }
        if (this.patch < other.patch) {
          return -1;
        }
        if (this.patch > other.patch) {
          return 1;
        }
        return 0;
      }
      comparePre(other) {
        if (!(other instanceof _SemVer)) {
          other = new _SemVer(other, this.options);
        }
        if (this.prerelease.length && !other.prerelease.length) {
          return -1;
        } else if (!this.prerelease.length && other.prerelease.length) {
          return 1;
        } else if (!this.prerelease.length && !other.prerelease.length) {
          return 0;
        }
        let i = 0;
        do {
          const a = this.prerelease[i];
          const b = other.prerelease[i];
          debug("prerelease compare", i, a, b);
          if (a === void 0 && b === void 0) {
            return 0;
          } else if (b === void 0) {
            return 1;
          } else if (a === void 0) {
            return -1;
          } else if (a === b) {
            continue;
          } else {
            return compareIdentifiers(a, b);
          }
        } while (++i);
      }
      compareBuild(other) {
        if (!(other instanceof _SemVer)) {
          other = new _SemVer(other, this.options);
        }
        let i = 0;
        do {
          const a = this.build[i];
          const b = other.build[i];
          debug("build compare", i, a, b);
          if (a === void 0 && b === void 0) {
            return 0;
          } else if (b === void 0) {
            return 1;
          } else if (a === void 0) {
            return -1;
          } else if (a === b) {
            continue;
          } else {
            return compareIdentifiers(a, b);
          }
        } while (++i);
      }
      // preminor will bump the version up to the next minor release, and immediately
      // down to pre-release. premajor and prepatch work the same way.
      inc(release, identifier, identifierBase) {
        if (release.startsWith("pre")) {
          if (!identifier && identifierBase === false) {
            throw new Error("invalid increment argument: identifier is empty");
          }
          if (identifier) {
            const match = `-${identifier}`.match(this.options.loose ? re[t.PRERELEASELOOSE] : re[t.PRERELEASE]);
            if (!match || match[1] !== identifier) {
              throw new Error(`invalid identifier: ${identifier}`);
            }
          }
        }
        switch (release) {
          case "premajor":
            this.prerelease.length = 0;
            this.patch = 0;
            this.minor = 0;
            this.major++;
            this.inc("pre", identifier, identifierBase);
            break;
          case "preminor":
            this.prerelease.length = 0;
            this.patch = 0;
            this.minor++;
            this.inc("pre", identifier, identifierBase);
            break;
          case "prepatch":
            this.prerelease.length = 0;
            this.inc("patch", identifier, identifierBase);
            this.inc("pre", identifier, identifierBase);
            break;
          // If the input is a non-prerelease version, this acts the same as
          // prepatch.
          case "prerelease":
            if (this.prerelease.length === 0) {
              this.inc("patch", identifier, identifierBase);
            }
            this.inc("pre", identifier, identifierBase);
            break;
          case "release":
            if (this.prerelease.length === 0) {
              throw new Error(`version ${this.raw} is not a prerelease`);
            }
            this.prerelease.length = 0;
            break;
          case "major":
            if (this.minor !== 0 || this.patch !== 0 || this.prerelease.length === 0) {
              this.major++;
            }
            this.minor = 0;
            this.patch = 0;
            this.prerelease = [];
            break;
          case "minor":
            if (this.patch !== 0 || this.prerelease.length === 0) {
              this.minor++;
            }
            this.patch = 0;
            this.prerelease = [];
            break;
          case "patch":
            if (this.prerelease.length === 0) {
              this.patch++;
            }
            this.prerelease = [];
            break;
          // This probably shouldn't be used publicly.
          // 1.0.0 'pre' would become 1.0.0-0 which is the wrong direction.
          case "pre": {
            const base = Number(identifierBase) ? 1 : 0;
            if (this.prerelease.length === 0) {
              this.prerelease = [base];
            } else {
              let i = this.prerelease.length;
              while (--i >= 0) {
                if (typeof this.prerelease[i] === "number") {
                  this.prerelease[i]++;
                  i = -2;
                }
              }
              if (i === -1) {
                if (identifier === this.prerelease.join(".") && identifierBase === false) {
                  throw new Error("invalid increment argument: identifier already exists");
                }
                this.prerelease.push(base);
              }
            }
            if (identifier) {
              let prerelease = [identifier, base];
              if (identifierBase === false) {
                prerelease = [identifier];
              }
              if (compareIdentifiers(this.prerelease[0], identifier) === 0) {
                if (isNaN(this.prerelease[1])) {
                  this.prerelease = prerelease;
                }
              } else {
                this.prerelease = prerelease;
              }
            }
            break;
          }
          default:
            throw new Error(`invalid increment argument: ${release}`);
        }
        this.raw = this.format();
        if (this.build.length) {
          this.raw += `+${this.build.join(".")}`;
        }
        return this;
      }
    };
    module2.exports = SemVer;
  }
});

// node_modules/.pnpm/semver@7.7.4/node_modules/semver/functions/parse.js
var require_parse = __commonJS({
  "node_modules/.pnpm/semver@7.7.4/node_modules/semver/functions/parse.js"(exports2, module2) {
    "use strict";
    var SemVer = require_semver();
    var parse = (version, options, throwErrors = false) => {
      if (version instanceof SemVer) {
        return version;
      }
      try {
        return new SemVer(version, options);
      } catch (er) {
        if (!throwErrors) {
          return null;
        }
        throw er;
      }
    };
    module2.exports = parse;
  }
});

// node_modules/.pnpm/semver@7.7.4/node_modules/semver/functions/valid.js
var require_valid = __commonJS({
  "node_modules/.pnpm/semver@7.7.4/node_modules/semver/functions/valid.js"(exports2, module2) {
    "use strict";
    var parse = require_parse();
    var valid = (version, options) => {
      const v = parse(version, options);
      return v ? v.version : null;
    };
    module2.exports = valid;
  }
});

// node_modules/.pnpm/semver@7.7.4/node_modules/semver/functions/clean.js
var require_clean = __commonJS({
  "node_modules/.pnpm/semver@7.7.4/node_modules/semver/functions/clean.js"(exports2, module2) {
    "use strict";
    var parse = require_parse();
    var clean = (version, options) => {
      const s = parse(version.trim().replace(/^[=v]+/, ""), options);
      return s ? s.version : null;
    };
    module2.exports = clean;
  }
});

// node_modules/.pnpm/semver@7.7.4/node_modules/semver/functions/inc.js
var require_inc = __commonJS({
  "node_modules/.pnpm/semver@7.7.4/node_modules/semver/functions/inc.js"(exports2, module2) {
    "use strict";
    var SemVer = require_semver();
    var inc = (version, release, options, identifier, identifierBase) => {
      if (typeof options === "string") {
        identifierBase = identifier;
        identifier = options;
        options = void 0;
      }
      try {
        return new SemVer(
          version instanceof SemVer ? version.version : version,
          options
        ).inc(release, identifier, identifierBase).version;
      } catch (er) {
        return null;
      }
    };
    module2.exports = inc;
  }
});

// node_modules/.pnpm/semver@7.7.4/node_modules/semver/functions/diff.js
var require_diff = __commonJS({
  "node_modules/.pnpm/semver@7.7.4/node_modules/semver/functions/diff.js"(exports2, module2) {
    "use strict";
    var parse = require_parse();
    var diff = (version1, version2) => {
      const v1 = parse(version1, null, true);
      const v2 = parse(version2, null, true);
      const comparison = v1.compare(v2);
      if (comparison === 0) {
        return null;
      }
      const v1Higher = comparison > 0;
      const highVersion = v1Higher ? v1 : v2;
      const lowVersion = v1Higher ? v2 : v1;
      const highHasPre = !!highVersion.prerelease.length;
      const lowHasPre = !!lowVersion.prerelease.length;
      if (lowHasPre && !highHasPre) {
        if (!lowVersion.patch && !lowVersion.minor) {
          return "major";
        }
        if (lowVersion.compareMain(highVersion) === 0) {
          if (lowVersion.minor && !lowVersion.patch) {
            return "minor";
          }
          return "patch";
        }
      }
      const prefix = highHasPre ? "pre" : "";
      if (v1.major !== v2.major) {
        return prefix + "major";
      }
      if (v1.minor !== v2.minor) {
        return prefix + "minor";
      }
      if (v1.patch !== v2.patch) {
        return prefix + "patch";
      }
      return "prerelease";
    };
    module2.exports = diff;
  }
});

// node_modules/.pnpm/semver@7.7.4/node_modules/semver/functions/major.js
var require_major = __commonJS({
  "node_modules/.pnpm/semver@7.7.4/node_modules/semver/functions/major.js"(exports2, module2) {
    "use strict";
    var SemVer = require_semver();
    var major = (a, loose) => new SemVer(a, loose).major;
    module2.exports = major;
  }
});

// node_modules/.pnpm/semver@7.7.4/node_modules/semver/functions/minor.js
var require_minor = __commonJS({
  "node_modules/.pnpm/semver@7.7.4/node_modules/semver/functions/minor.js"(exports2, module2) {
    "use strict";
    var SemVer = require_semver();
    var minor = (a, loose) => new SemVer(a, loose).minor;
    module2.exports = minor;
  }
});

// node_modules/.pnpm/semver@7.7.4/node_modules/semver/functions/patch.js
var require_patch = __commonJS({
  "node_modules/.pnpm/semver@7.7.4/node_modules/semver/functions/patch.js"(exports2, module2) {
    "use strict";
    var SemVer = require_semver();
    var patch = (a, loose) => new SemVer(a, loose).patch;
    module2.exports = patch;
  }
});

// node_modules/.pnpm/semver@7.7.4/node_modules/semver/functions/prerelease.js
var require_prerelease = __commonJS({
  "node_modules/.pnpm/semver@7.7.4/node_modules/semver/functions/prerelease.js"(exports2, module2) {
    "use strict";
    var parse = require_parse();
    var prerelease = (version, options) => {
      const parsed = parse(version, options);
      return parsed && parsed.prerelease.length ? parsed.prerelease : null;
    };
    module2.exports = prerelease;
  }
});

// node_modules/.pnpm/semver@7.7.4/node_modules/semver/functions/compare.js
var require_compare = __commonJS({
  "node_modules/.pnpm/semver@7.7.4/node_modules/semver/functions/compare.js"(exports2, module2) {
    "use strict";
    var SemVer = require_semver();
    var compare = (a, b, loose) => new SemVer(a, loose).compare(new SemVer(b, loose));
    module2.exports = compare;
  }
});

// node_modules/.pnpm/semver@7.7.4/node_modules/semver/functions/rcompare.js
var require_rcompare = __commonJS({
  "node_modules/.pnpm/semver@7.7.4/node_modules/semver/functions/rcompare.js"(exports2, module2) {
    "use strict";
    var compare = require_compare();
    var rcompare = (a, b, loose) => compare(b, a, loose);
    module2.exports = rcompare;
  }
});

// node_modules/.pnpm/semver@7.7.4/node_modules/semver/functions/compare-loose.js
var require_compare_loose = __commonJS({
  "node_modules/.pnpm/semver@7.7.4/node_modules/semver/functions/compare-loose.js"(exports2, module2) {
    "use strict";
    var compare = require_compare();
    var compareLoose = (a, b) => compare(a, b, true);
    module2.exports = compareLoose;
  }
});

// node_modules/.pnpm/semver@7.7.4/node_modules/semver/functions/compare-build.js
var require_compare_build = __commonJS({
  "node_modules/.pnpm/semver@7.7.4/node_modules/semver/functions/compare-build.js"(exports2, module2) {
    "use strict";
    var SemVer = require_semver();
    var compareBuild = (a, b, loose) => {
      const versionA = new SemVer(a, loose);
      const versionB = new SemVer(b, loose);
      return versionA.compare(versionB) || versionA.compareBuild(versionB);
    };
    module2.exports = compareBuild;
  }
});

// node_modules/.pnpm/semver@7.7.4/node_modules/semver/functions/sort.js
var require_sort = __commonJS({
  "node_modules/.pnpm/semver@7.7.4/node_modules/semver/functions/sort.js"(exports2, module2) {
    "use strict";
    var compareBuild = require_compare_build();
    var sort = (list, loose) => list.sort((a, b) => compareBuild(a, b, loose));
    module2.exports = sort;
  }
});

// node_modules/.pnpm/semver@7.7.4/node_modules/semver/functions/rsort.js
var require_rsort = __commonJS({
  "node_modules/.pnpm/semver@7.7.4/node_modules/semver/functions/rsort.js"(exports2, module2) {
    "use strict";
    var compareBuild = require_compare_build();
    var rsort = (list, loose) => list.sort((a, b) => compareBuild(b, a, loose));
    module2.exports = rsort;
  }
});

// node_modules/.pnpm/semver@7.7.4/node_modules/semver/functions/gt.js
var require_gt = __commonJS({
  "node_modules/.pnpm/semver@7.7.4/node_modules/semver/functions/gt.js"(exports2, module2) {
    "use strict";
    var compare = require_compare();
    var gt = (a, b, loose) => compare(a, b, loose) > 0;
    module2.exports = gt;
  }
});

// node_modules/.pnpm/semver@7.7.4/node_modules/semver/functions/lt.js
var require_lt = __commonJS({
  "node_modules/.pnpm/semver@7.7.4/node_modules/semver/functions/lt.js"(exports2, module2) {
    "use strict";
    var compare = require_compare();
    var lt = (a, b, loose) => compare(a, b, loose) < 0;
    module2.exports = lt;
  }
});

// node_modules/.pnpm/semver@7.7.4/node_modules/semver/functions/eq.js
var require_eq = __commonJS({
  "node_modules/.pnpm/semver@7.7.4/node_modules/semver/functions/eq.js"(exports2, module2) {
    "use strict";
    var compare = require_compare();
    var eq = (a, b, loose) => compare(a, b, loose) === 0;
    module2.exports = eq;
  }
});

// node_modules/.pnpm/semver@7.7.4/node_modules/semver/functions/neq.js
var require_neq = __commonJS({
  "node_modules/.pnpm/semver@7.7.4/node_modules/semver/functions/neq.js"(exports2, module2) {
    "use strict";
    var compare = require_compare();
    var neq = (a, b, loose) => compare(a, b, loose) !== 0;
    module2.exports = neq;
  }
});

// node_modules/.pnpm/semver@7.7.4/node_modules/semver/functions/gte.js
var require_gte = __commonJS({
  "node_modules/.pnpm/semver@7.7.4/node_modules/semver/functions/gte.js"(exports2, module2) {
    "use strict";
    var compare = require_compare();
    var gte = (a, b, loose) => compare(a, b, loose) >= 0;
    module2.exports = gte;
  }
});

// node_modules/.pnpm/semver@7.7.4/node_modules/semver/functions/lte.js
var require_lte = __commonJS({
  "node_modules/.pnpm/semver@7.7.4/node_modules/semver/functions/lte.js"(exports2, module2) {
    "use strict";
    var compare = require_compare();
    var lte = (a, b, loose) => compare(a, b, loose) <= 0;
    module2.exports = lte;
  }
});

// node_modules/.pnpm/semver@7.7.4/node_modules/semver/functions/cmp.js
var require_cmp = __commonJS({
  "node_modules/.pnpm/semver@7.7.4/node_modules/semver/functions/cmp.js"(exports2, module2) {
    "use strict";
    var eq = require_eq();
    var neq = require_neq();
    var gt = require_gt();
    var gte = require_gte();
    var lt = require_lt();
    var lte = require_lte();
    var cmp = (a, op, b, loose) => {
      switch (op) {
        case "===":
          if (typeof a === "object") {
            a = a.version;
          }
          if (typeof b === "object") {
            b = b.version;
          }
          return a === b;
        case "!==":
          if (typeof a === "object") {
            a = a.version;
          }
          if (typeof b === "object") {
            b = b.version;
          }
          return a !== b;
        case "":
        case "=":
        case "==":
          return eq(a, b, loose);
        case "!=":
          return neq(a, b, loose);
        case ">":
          return gt(a, b, loose);
        case ">=":
          return gte(a, b, loose);
        case "<":
          return lt(a, b, loose);
        case "<=":
          return lte(a, b, loose);
        default:
          throw new TypeError(`Invalid operator: ${op}`);
      }
    };
    module2.exports = cmp;
  }
});

// node_modules/.pnpm/semver@7.7.4/node_modules/semver/functions/coerce.js
var require_coerce = __commonJS({
  "node_modules/.pnpm/semver@7.7.4/node_modules/semver/functions/coerce.js"(exports2, module2) {
    "use strict";
    var SemVer = require_semver();
    var parse = require_parse();
    var { safeRe: re, t } = require_re();
    var coerce = (version, options) => {
      if (version instanceof SemVer) {
        return version;
      }
      if (typeof version === "number") {
        version = String(version);
      }
      if (typeof version !== "string") {
        return null;
      }
      options = options || {};
      let match = null;
      if (!options.rtl) {
        match = version.match(options.includePrerelease ? re[t.COERCEFULL] : re[t.COERCE]);
      } else {
        const coerceRtlRegex = options.includePrerelease ? re[t.COERCERTLFULL] : re[t.COERCERTL];
        let next;
        while ((next = coerceRtlRegex.exec(version)) && (!match || match.index + match[0].length !== version.length)) {
          if (!match || next.index + next[0].length !== match.index + match[0].length) {
            match = next;
          }
          coerceRtlRegex.lastIndex = next.index + next[1].length + next[2].length;
        }
        coerceRtlRegex.lastIndex = -1;
      }
      if (match === null) {
        return null;
      }
      const major = match[2];
      const minor = match[3] || "0";
      const patch = match[4] || "0";
      const prerelease = options.includePrerelease && match[5] ? `-${match[5]}` : "";
      const build = options.includePrerelease && match[6] ? `+${match[6]}` : "";
      return parse(`${major}.${minor}.${patch}${prerelease}${build}`, options);
    };
    module2.exports = coerce;
  }
});

// node_modules/.pnpm/semver@7.7.4/node_modules/semver/internal/lrucache.js
var require_lrucache = __commonJS({
  "node_modules/.pnpm/semver@7.7.4/node_modules/semver/internal/lrucache.js"(exports2, module2) {
    "use strict";
    var LRUCache = class {
      constructor() {
        this.max = 1e3;
        this.map = /* @__PURE__ */ new Map();
      }
      get(key) {
        const value = this.map.get(key);
        if (value === void 0) {
          return void 0;
        } else {
          this.map.delete(key);
          this.map.set(key, value);
          return value;
        }
      }
      delete(key) {
        return this.map.delete(key);
      }
      set(key, value) {
        const deleted = this.delete(key);
        if (!deleted && value !== void 0) {
          if (this.map.size >= this.max) {
            const firstKey = this.map.keys().next().value;
            this.delete(firstKey);
          }
          this.map.set(key, value);
        }
        return this;
      }
    };
    module2.exports = LRUCache;
  }
});

// node_modules/.pnpm/semver@7.7.4/node_modules/semver/classes/range.js
var require_range = __commonJS({
  "node_modules/.pnpm/semver@7.7.4/node_modules/semver/classes/range.js"(exports2, module2) {
    "use strict";
    var SPACE_CHARACTERS = /\s+/g;
    var Range = class _Range {
      constructor(range, options) {
        options = parseOptions(options);
        if (range instanceof _Range) {
          if (range.loose === !!options.loose && range.includePrerelease === !!options.includePrerelease) {
            return range;
          } else {
            return new _Range(range.raw, options);
          }
        }
        if (range instanceof Comparator) {
          this.raw = range.value;
          this.set = [[range]];
          this.formatted = void 0;
          return this;
        }
        this.options = options;
        this.loose = !!options.loose;
        this.includePrerelease = !!options.includePrerelease;
        this.raw = range.trim().replace(SPACE_CHARACTERS, " ");
        this.set = this.raw.split("||").map((r) => this.parseRange(r.trim())).filter((c) => c.length);
        if (!this.set.length) {
          throw new TypeError(`Invalid SemVer Range: ${this.raw}`);
        }
        if (this.set.length > 1) {
          const first = this.set[0];
          this.set = this.set.filter((c) => !isNullSet(c[0]));
          if (this.set.length === 0) {
            this.set = [first];
          } else if (this.set.length > 1) {
            for (const c of this.set) {
              if (c.length === 1 && isAny(c[0])) {
                this.set = [c];
                break;
              }
            }
          }
        }
        this.formatted = void 0;
      }
      get range() {
        if (this.formatted === void 0) {
          this.formatted = "";
          for (let i = 0; i < this.set.length; i++) {
            if (i > 0) {
              this.formatted += "||";
            }
            const comps = this.set[i];
            for (let k = 0; k < comps.length; k++) {
              if (k > 0) {
                this.formatted += " ";
              }
              this.formatted += comps[k].toString().trim();
            }
          }
        }
        return this.formatted;
      }
      format() {
        return this.range;
      }
      toString() {
        return this.range;
      }
      parseRange(range) {
        const memoOpts = (this.options.includePrerelease && FLAG_INCLUDE_PRERELEASE) | (this.options.loose && FLAG_LOOSE);
        const memoKey = memoOpts + ":" + range;
        const cached = cache.get(memoKey);
        if (cached) {
          return cached;
        }
        const loose = this.options.loose;
        const hr = loose ? re[t.HYPHENRANGELOOSE] : re[t.HYPHENRANGE];
        range = range.replace(hr, hyphenReplace(this.options.includePrerelease));
        debug("hyphen replace", range);
        range = range.replace(re[t.COMPARATORTRIM], comparatorTrimReplace);
        debug("comparator trim", range);
        range = range.replace(re[t.TILDETRIM], tildeTrimReplace);
        debug("tilde trim", range);
        range = range.replace(re[t.CARETTRIM], caretTrimReplace);
        debug("caret trim", range);
        let rangeList = range.split(" ").map((comp) => parseComparator(comp, this.options)).join(" ").split(/\s+/).map((comp) => replaceGTE0(comp, this.options));
        if (loose) {
          rangeList = rangeList.filter((comp) => {
            debug("loose invalid filter", comp, this.options);
            return !!comp.match(re[t.COMPARATORLOOSE]);
          });
        }
        debug("range list", rangeList);
        const rangeMap = /* @__PURE__ */ new Map();
        const comparators = rangeList.map((comp) => new Comparator(comp, this.options));
        for (const comp of comparators) {
          if (isNullSet(comp)) {
            return [comp];
          }
          rangeMap.set(comp.value, comp);
        }
        if (rangeMap.size > 1 && rangeMap.has("")) {
          rangeMap.delete("");
        }
        const result = [...rangeMap.values()];
        cache.set(memoKey, result);
        return result;
      }
      intersects(range, options) {
        if (!(range instanceof _Range)) {
          throw new TypeError("a Range is required");
        }
        return this.set.some((thisComparators) => {
          return isSatisfiable(thisComparators, options) && range.set.some((rangeComparators) => {
            return isSatisfiable(rangeComparators, options) && thisComparators.every((thisComparator) => {
              return rangeComparators.every((rangeComparator) => {
                return thisComparator.intersects(rangeComparator, options);
              });
            });
          });
        });
      }
      // if ANY of the sets match ALL of its comparators, then pass
      test(version) {
        if (!version) {
          return false;
        }
        if (typeof version === "string") {
          try {
            version = new SemVer(version, this.options);
          } catch (er) {
            return false;
          }
        }
        for (let i = 0; i < this.set.length; i++) {
          if (testSet(this.set[i], version, this.options)) {
            return true;
          }
        }
        return false;
      }
    };
    module2.exports = Range;
    var LRU = require_lrucache();
    var cache = new LRU();
    var parseOptions = require_parse_options();
    var Comparator = require_comparator();
    var debug = require_debug();
    var SemVer = require_semver();
    var {
      safeRe: re,
      t,
      comparatorTrimReplace,
      tildeTrimReplace,
      caretTrimReplace
    } = require_re();
    var { FLAG_INCLUDE_PRERELEASE, FLAG_LOOSE } = require_constants();
    var isNullSet = (c) => c.value === "<0.0.0-0";
    var isAny = (c) => c.value === "";
    var isSatisfiable = (comparators, options) => {
      let result = true;
      const remainingComparators = comparators.slice();
      let testComparator = remainingComparators.pop();
      while (result && remainingComparators.length) {
        result = remainingComparators.every((otherComparator) => {
          return testComparator.intersects(otherComparator, options);
        });
        testComparator = remainingComparators.pop();
      }
      return result;
    };
    var parseComparator = (comp, options) => {
      comp = comp.replace(re[t.BUILD], "");
      debug("comp", comp, options);
      comp = replaceCarets(comp, options);
      debug("caret", comp);
      comp = replaceTildes(comp, options);
      debug("tildes", comp);
      comp = replaceXRanges(comp, options);
      debug("xrange", comp);
      comp = replaceStars(comp, options);
      debug("stars", comp);
      return comp;
    };
    var isX = (id) => !id || id.toLowerCase() === "x" || id === "*";
    var replaceTildes = (comp, options) => {
      return comp.trim().split(/\s+/).map((c) => replaceTilde(c, options)).join(" ");
    };
    var replaceTilde = (comp, options) => {
      const r = options.loose ? re[t.TILDELOOSE] : re[t.TILDE];
      return comp.replace(r, (_, M, m, p, pr) => {
        debug("tilde", comp, _, M, m, p, pr);
        let ret;
        if (isX(M)) {
          ret = "";
        } else if (isX(m)) {
          ret = `>=${M}.0.0 <${+M + 1}.0.0-0`;
        } else if (isX(p)) {
          ret = `>=${M}.${m}.0 <${M}.${+m + 1}.0-0`;
        } else if (pr) {
          debug("replaceTilde pr", pr);
          ret = `>=${M}.${m}.${p}-${pr} <${M}.${+m + 1}.0-0`;
        } else {
          ret = `>=${M}.${m}.${p} <${M}.${+m + 1}.0-0`;
        }
        debug("tilde return", ret);
        return ret;
      });
    };
    var replaceCarets = (comp, options) => {
      return comp.trim().split(/\s+/).map((c) => replaceCaret(c, options)).join(" ");
    };
    var replaceCaret = (comp, options) => {
      debug("caret", comp, options);
      const r = options.loose ? re[t.CARETLOOSE] : re[t.CARET];
      const z = options.includePrerelease ? "-0" : "";
      return comp.replace(r, (_, M, m, p, pr) => {
        debug("caret", comp, _, M, m, p, pr);
        let ret;
        if (isX(M)) {
          ret = "";
        } else if (isX(m)) {
          ret = `>=${M}.0.0${z} <${+M + 1}.0.0-0`;
        } else if (isX(p)) {
          if (M === "0") {
            ret = `>=${M}.${m}.0${z} <${M}.${+m + 1}.0-0`;
          } else {
            ret = `>=${M}.${m}.0${z} <${+M + 1}.0.0-0`;
          }
        } else if (pr) {
          debug("replaceCaret pr", pr);
          if (M === "0") {
            if (m === "0") {
              ret = `>=${M}.${m}.${p}-${pr} <${M}.${m}.${+p + 1}-0`;
            } else {
              ret = `>=${M}.${m}.${p}-${pr} <${M}.${+m + 1}.0-0`;
            }
          } else {
            ret = `>=${M}.${m}.${p}-${pr} <${+M + 1}.0.0-0`;
          }
        } else {
          debug("no pr");
          if (M === "0") {
            if (m === "0") {
              ret = `>=${M}.${m}.${p}${z} <${M}.${m}.${+p + 1}-0`;
            } else {
              ret = `>=${M}.${m}.${p}${z} <${M}.${+m + 1}.0-0`;
            }
          } else {
            ret = `>=${M}.${m}.${p} <${+M + 1}.0.0-0`;
          }
        }
        debug("caret return", ret);
        return ret;
      });
    };
    var replaceXRanges = (comp, options) => {
      debug("replaceXRanges", comp, options);
      return comp.split(/\s+/).map((c) => replaceXRange(c, options)).join(" ");
    };
    var replaceXRange = (comp, options) => {
      comp = comp.trim();
      const r = options.loose ? re[t.XRANGELOOSE] : re[t.XRANGE];
      return comp.replace(r, (ret, gtlt, M, m, p, pr) => {
        debug("xRange", comp, ret, gtlt, M, m, p, pr);
        const xM = isX(M);
        const xm = xM || isX(m);
        const xp = xm || isX(p);
        const anyX = xp;
        if (gtlt === "=" && anyX) {
          gtlt = "";
        }
        pr = options.includePrerelease ? "-0" : "";
        if (xM) {
          if (gtlt === ">" || gtlt === "<") {
            ret = "<0.0.0-0";
          } else {
            ret = "*";
          }
        } else if (gtlt && anyX) {
          if (xm) {
            m = 0;
          }
          p = 0;
          if (gtlt === ">") {
            gtlt = ">=";
            if (xm) {
              M = +M + 1;
              m = 0;
              p = 0;
            } else {
              m = +m + 1;
              p = 0;
            }
          } else if (gtlt === "<=") {
            gtlt = "<";
            if (xm) {
              M = +M + 1;
            } else {
              m = +m + 1;
            }
          }
          if (gtlt === "<") {
            pr = "-0";
          }
          ret = `${gtlt + M}.${m}.${p}${pr}`;
        } else if (xm) {
          ret = `>=${M}.0.0${pr} <${+M + 1}.0.0-0`;
        } else if (xp) {
          ret = `>=${M}.${m}.0${pr} <${M}.${+m + 1}.0-0`;
        }
        debug("xRange return", ret);
        return ret;
      });
    };
    var replaceStars = (comp, options) => {
      debug("replaceStars", comp, options);
      return comp.trim().replace(re[t.STAR], "");
    };
    var replaceGTE0 = (comp, options) => {
      debug("replaceGTE0", comp, options);
      return comp.trim().replace(re[options.includePrerelease ? t.GTE0PRE : t.GTE0], "");
    };
    var hyphenReplace = (incPr) => ($0, from, fM, fm, fp, fpr, fb, to, tM, tm, tp, tpr) => {
      if (isX(fM)) {
        from = "";
      } else if (isX(fm)) {
        from = `>=${fM}.0.0${incPr ? "-0" : ""}`;
      } else if (isX(fp)) {
        from = `>=${fM}.${fm}.0${incPr ? "-0" : ""}`;
      } else if (fpr) {
        from = `>=${from}`;
      } else {
        from = `>=${from}${incPr ? "-0" : ""}`;
      }
      if (isX(tM)) {
        to = "";
      } else if (isX(tm)) {
        to = `<${+tM + 1}.0.0-0`;
      } else if (isX(tp)) {
        to = `<${tM}.${+tm + 1}.0-0`;
      } else if (tpr) {
        to = `<=${tM}.${tm}.${tp}-${tpr}`;
      } else if (incPr) {
        to = `<${tM}.${tm}.${+tp + 1}-0`;
      } else {
        to = `<=${to}`;
      }
      return `${from} ${to}`.trim();
    };
    var testSet = (set, version, options) => {
      for (let i = 0; i < set.length; i++) {
        if (!set[i].test(version)) {
          return false;
        }
      }
      if (version.prerelease.length && !options.includePrerelease) {
        for (let i = 0; i < set.length; i++) {
          debug(set[i].semver);
          if (set[i].semver === Comparator.ANY) {
            continue;
          }
          if (set[i].semver.prerelease.length > 0) {
            const allowed = set[i].semver;
            if (allowed.major === version.major && allowed.minor === version.minor && allowed.patch === version.patch) {
              return true;
            }
          }
        }
        return false;
      }
      return true;
    };
  }
});

// node_modules/.pnpm/semver@7.7.4/node_modules/semver/classes/comparator.js
var require_comparator = __commonJS({
  "node_modules/.pnpm/semver@7.7.4/node_modules/semver/classes/comparator.js"(exports2, module2) {
    "use strict";
    var ANY = /* @__PURE__ */ Symbol("SemVer ANY");
    var Comparator = class _Comparator {
      static get ANY() {
        return ANY;
      }
      constructor(comp, options) {
        options = parseOptions(options);
        if (comp instanceof _Comparator) {
          if (comp.loose === !!options.loose) {
            return comp;
          } else {
            comp = comp.value;
          }
        }
        comp = comp.trim().split(/\s+/).join(" ");
        debug("comparator", comp, options);
        this.options = options;
        this.loose = !!options.loose;
        this.parse(comp);
        if (this.semver === ANY) {
          this.value = "";
        } else {
          this.value = this.operator + this.semver.version;
        }
        debug("comp", this);
      }
      parse(comp) {
        const r = this.options.loose ? re[t.COMPARATORLOOSE] : re[t.COMPARATOR];
        const m = comp.match(r);
        if (!m) {
          throw new TypeError(`Invalid comparator: ${comp}`);
        }
        this.operator = m[1] !== void 0 ? m[1] : "";
        if (this.operator === "=") {
          this.operator = "";
        }
        if (!m[2]) {
          this.semver = ANY;
        } else {
          this.semver = new SemVer(m[2], this.options.loose);
        }
      }
      toString() {
        return this.value;
      }
      test(version) {
        debug("Comparator.test", version, this.options.loose);
        if (this.semver === ANY || version === ANY) {
          return true;
        }
        if (typeof version === "string") {
          try {
            version = new SemVer(version, this.options);
          } catch (er) {
            return false;
          }
        }
        return cmp(version, this.operator, this.semver, this.options);
      }
      intersects(comp, options) {
        if (!(comp instanceof _Comparator)) {
          throw new TypeError("a Comparator is required");
        }
        if (this.operator === "") {
          if (this.value === "") {
            return true;
          }
          return new Range(comp.value, options).test(this.value);
        } else if (comp.operator === "") {
          if (comp.value === "") {
            return true;
          }
          return new Range(this.value, options).test(comp.semver);
        }
        options = parseOptions(options);
        if (options.includePrerelease && (this.value === "<0.0.0-0" || comp.value === "<0.0.0-0")) {
          return false;
        }
        if (!options.includePrerelease && (this.value.startsWith("<0.0.0") || comp.value.startsWith("<0.0.0"))) {
          return false;
        }
        if (this.operator.startsWith(">") && comp.operator.startsWith(">")) {
          return true;
        }
        if (this.operator.startsWith("<") && comp.operator.startsWith("<")) {
          return true;
        }
        if (this.semver.version === comp.semver.version && this.operator.includes("=") && comp.operator.includes("=")) {
          return true;
        }
        if (cmp(this.semver, "<", comp.semver, options) && this.operator.startsWith(">") && comp.operator.startsWith("<")) {
          return true;
        }
        if (cmp(this.semver, ">", comp.semver, options) && this.operator.startsWith("<") && comp.operator.startsWith(">")) {
          return true;
        }
        return false;
      }
    };
    module2.exports = Comparator;
    var parseOptions = require_parse_options();
    var { safeRe: re, t } = require_re();
    var cmp = require_cmp();
    var debug = require_debug();
    var SemVer = require_semver();
    var Range = require_range();
  }
});

// node_modules/.pnpm/semver@7.7.4/node_modules/semver/functions/satisfies.js
var require_satisfies = __commonJS({
  "node_modules/.pnpm/semver@7.7.4/node_modules/semver/functions/satisfies.js"(exports2, module2) {
    "use strict";
    var Range = require_range();
    var satisfies = (version, range, options) => {
      try {
        range = new Range(range, options);
      } catch (er) {
        return false;
      }
      return range.test(version);
    };
    module2.exports = satisfies;
  }
});

// node_modules/.pnpm/semver@7.7.4/node_modules/semver/ranges/to-comparators.js
var require_to_comparators = __commonJS({
  "node_modules/.pnpm/semver@7.7.4/node_modules/semver/ranges/to-comparators.js"(exports2, module2) {
    "use strict";
    var Range = require_range();
    var toComparators = (range, options) => new Range(range, options).set.map((comp) => comp.map((c) => c.value).join(" ").trim().split(" "));
    module2.exports = toComparators;
  }
});

// node_modules/.pnpm/semver@7.7.4/node_modules/semver/ranges/max-satisfying.js
var require_max_satisfying = __commonJS({
  "node_modules/.pnpm/semver@7.7.4/node_modules/semver/ranges/max-satisfying.js"(exports2, module2) {
    "use strict";
    var SemVer = require_semver();
    var Range = require_range();
    var maxSatisfying = (versions, range, options) => {
      let max = null;
      let maxSV = null;
      let rangeObj = null;
      try {
        rangeObj = new Range(range, options);
      } catch (er) {
        return null;
      }
      versions.forEach((v) => {
        if (rangeObj.test(v)) {
          if (!max || maxSV.compare(v) === -1) {
            max = v;
            maxSV = new SemVer(max, options);
          }
        }
      });
      return max;
    };
    module2.exports = maxSatisfying;
  }
});

// node_modules/.pnpm/semver@7.7.4/node_modules/semver/ranges/min-satisfying.js
var require_min_satisfying = __commonJS({
  "node_modules/.pnpm/semver@7.7.4/node_modules/semver/ranges/min-satisfying.js"(exports2, module2) {
    "use strict";
    var SemVer = require_semver();
    var Range = require_range();
    var minSatisfying = (versions, range, options) => {
      let min = null;
      let minSV = null;
      let rangeObj = null;
      try {
        rangeObj = new Range(range, options);
      } catch (er) {
        return null;
      }
      versions.forEach((v) => {
        if (rangeObj.test(v)) {
          if (!min || minSV.compare(v) === 1) {
            min = v;
            minSV = new SemVer(min, options);
          }
        }
      });
      return min;
    };
    module2.exports = minSatisfying;
  }
});

// node_modules/.pnpm/semver@7.7.4/node_modules/semver/ranges/min-version.js
var require_min_version = __commonJS({
  "node_modules/.pnpm/semver@7.7.4/node_modules/semver/ranges/min-version.js"(exports2, module2) {
    "use strict";
    var SemVer = require_semver();
    var Range = require_range();
    var gt = require_gt();
    var minVersion = (range, loose) => {
      range = new Range(range, loose);
      let minver = new SemVer("0.0.0");
      if (range.test(minver)) {
        return minver;
      }
      minver = new SemVer("0.0.0-0");
      if (range.test(minver)) {
        return minver;
      }
      minver = null;
      for (let i = 0; i < range.set.length; ++i) {
        const comparators = range.set[i];
        let setMin = null;
        comparators.forEach((comparator) => {
          const compver = new SemVer(comparator.semver.version);
          switch (comparator.operator) {
            case ">":
              if (compver.prerelease.length === 0) {
                compver.patch++;
              } else {
                compver.prerelease.push(0);
              }
              compver.raw = compver.format();
            /* fallthrough */
            case "":
            case ">=":
              if (!setMin || gt(compver, setMin)) {
                setMin = compver;
              }
              break;
            case "<":
            case "<=":
              break;
            /* istanbul ignore next */
            default:
              throw new Error(`Unexpected operation: ${comparator.operator}`);
          }
        });
        if (setMin && (!minver || gt(minver, setMin))) {
          minver = setMin;
        }
      }
      if (minver && range.test(minver)) {
        return minver;
      }
      return null;
    };
    module2.exports = minVersion;
  }
});

// node_modules/.pnpm/semver@7.7.4/node_modules/semver/ranges/valid.js
var require_valid2 = __commonJS({
  "node_modules/.pnpm/semver@7.7.4/node_modules/semver/ranges/valid.js"(exports2, module2) {
    "use strict";
    var Range = require_range();
    var validRange = (range, options) => {
      try {
        return new Range(range, options).range || "*";
      } catch (er) {
        return null;
      }
    };
    module2.exports = validRange;
  }
});

// node_modules/.pnpm/semver@7.7.4/node_modules/semver/ranges/outside.js
var require_outside = __commonJS({
  "node_modules/.pnpm/semver@7.7.4/node_modules/semver/ranges/outside.js"(exports2, module2) {
    "use strict";
    var SemVer = require_semver();
    var Comparator = require_comparator();
    var { ANY } = Comparator;
    var Range = require_range();
    var satisfies = require_satisfies();
    var gt = require_gt();
    var lt = require_lt();
    var lte = require_lte();
    var gte = require_gte();
    var outside = (version, range, hilo, options) => {
      version = new SemVer(version, options);
      range = new Range(range, options);
      let gtfn, ltefn, ltfn, comp, ecomp;
      switch (hilo) {
        case ">":
          gtfn = gt;
          ltefn = lte;
          ltfn = lt;
          comp = ">";
          ecomp = ">=";
          break;
        case "<":
          gtfn = lt;
          ltefn = gte;
          ltfn = gt;
          comp = "<";
          ecomp = "<=";
          break;
        default:
          throw new TypeError('Must provide a hilo val of "<" or ">"');
      }
      if (satisfies(version, range, options)) {
        return false;
      }
      for (let i = 0; i < range.set.length; ++i) {
        const comparators = range.set[i];
        let high = null;
        let low = null;
        comparators.forEach((comparator) => {
          if (comparator.semver === ANY) {
            comparator = new Comparator(">=0.0.0");
          }
          high = high || comparator;
          low = low || comparator;
          if (gtfn(comparator.semver, high.semver, options)) {
            high = comparator;
          } else if (ltfn(comparator.semver, low.semver, options)) {
            low = comparator;
          }
        });
        if (high.operator === comp || high.operator === ecomp) {
          return false;
        }
        if ((!low.operator || low.operator === comp) && ltefn(version, low.semver)) {
          return false;
        } else if (low.operator === ecomp && ltfn(version, low.semver)) {
          return false;
        }
      }
      return true;
    };
    module2.exports = outside;
  }
});

// node_modules/.pnpm/semver@7.7.4/node_modules/semver/ranges/gtr.js
var require_gtr = __commonJS({
  "node_modules/.pnpm/semver@7.7.4/node_modules/semver/ranges/gtr.js"(exports2, module2) {
    "use strict";
    var outside = require_outside();
    var gtr = (version, range, options) => outside(version, range, ">", options);
    module2.exports = gtr;
  }
});

// node_modules/.pnpm/semver@7.7.4/node_modules/semver/ranges/ltr.js
var require_ltr = __commonJS({
  "node_modules/.pnpm/semver@7.7.4/node_modules/semver/ranges/ltr.js"(exports2, module2) {
    "use strict";
    var outside = require_outside();
    var ltr = (version, range, options) => outside(version, range, "<", options);
    module2.exports = ltr;
  }
});

// node_modules/.pnpm/semver@7.7.4/node_modules/semver/ranges/intersects.js
var require_intersects = __commonJS({
  "node_modules/.pnpm/semver@7.7.4/node_modules/semver/ranges/intersects.js"(exports2, module2) {
    "use strict";
    var Range = require_range();
    var intersects = (r1, r2, options) => {
      r1 = new Range(r1, options);
      r2 = new Range(r2, options);
      return r1.intersects(r2, options);
    };
    module2.exports = intersects;
  }
});

// node_modules/.pnpm/semver@7.7.4/node_modules/semver/ranges/simplify.js
var require_simplify = __commonJS({
  "node_modules/.pnpm/semver@7.7.4/node_modules/semver/ranges/simplify.js"(exports2, module2) {
    "use strict";
    var satisfies = require_satisfies();
    var compare = require_compare();
    module2.exports = (versions, range, options) => {
      const set = [];
      let first = null;
      let prev = null;
      const v = versions.sort((a, b) => compare(a, b, options));
      for (const version of v) {
        const included = satisfies(version, range, options);
        if (included) {
          prev = version;
          if (!first) {
            first = version;
          }
        } else {
          if (prev) {
            set.push([first, prev]);
          }
          prev = null;
          first = null;
        }
      }
      if (first) {
        set.push([first, null]);
      }
      const ranges = [];
      for (const [min, max] of set) {
        if (min === max) {
          ranges.push(min);
        } else if (!max && min === v[0]) {
          ranges.push("*");
        } else if (!max) {
          ranges.push(`>=${min}`);
        } else if (min === v[0]) {
          ranges.push(`<=${max}`);
        } else {
          ranges.push(`${min} - ${max}`);
        }
      }
      const simplified = ranges.join(" || ");
      const original = typeof range.raw === "string" ? range.raw : String(range);
      return simplified.length < original.length ? simplified : range;
    };
  }
});

// node_modules/.pnpm/semver@7.7.4/node_modules/semver/ranges/subset.js
var require_subset = __commonJS({
  "node_modules/.pnpm/semver@7.7.4/node_modules/semver/ranges/subset.js"(exports2, module2) {
    "use strict";
    var Range = require_range();
    var Comparator = require_comparator();
    var { ANY } = Comparator;
    var satisfies = require_satisfies();
    var compare = require_compare();
    var subset = (sub, dom, options = {}) => {
      if (sub === dom) {
        return true;
      }
      sub = new Range(sub, options);
      dom = new Range(dom, options);
      let sawNonNull = false;
      OUTER: for (const simpleSub of sub.set) {
        for (const simpleDom of dom.set) {
          const isSub = simpleSubset(simpleSub, simpleDom, options);
          sawNonNull = sawNonNull || isSub !== null;
          if (isSub) {
            continue OUTER;
          }
        }
        if (sawNonNull) {
          return false;
        }
      }
      return true;
    };
    var minimumVersionWithPreRelease = [new Comparator(">=0.0.0-0")];
    var minimumVersion = [new Comparator(">=0.0.0")];
    var simpleSubset = (sub, dom, options) => {
      if (sub === dom) {
        return true;
      }
      if (sub.length === 1 && sub[0].semver === ANY) {
        if (dom.length === 1 && dom[0].semver === ANY) {
          return true;
        } else if (options.includePrerelease) {
          sub = minimumVersionWithPreRelease;
        } else {
          sub = minimumVersion;
        }
      }
      if (dom.length === 1 && dom[0].semver === ANY) {
        if (options.includePrerelease) {
          return true;
        } else {
          dom = minimumVersion;
        }
      }
      const eqSet = /* @__PURE__ */ new Set();
      let gt, lt;
      for (const c of sub) {
        if (c.operator === ">" || c.operator === ">=") {
          gt = higherGT(gt, c, options);
        } else if (c.operator === "<" || c.operator === "<=") {
          lt = lowerLT(lt, c, options);
        } else {
          eqSet.add(c.semver);
        }
      }
      if (eqSet.size > 1) {
        return null;
      }
      let gtltComp;
      if (gt && lt) {
        gtltComp = compare(gt.semver, lt.semver, options);
        if (gtltComp > 0) {
          return null;
        } else if (gtltComp === 0 && (gt.operator !== ">=" || lt.operator !== "<=")) {
          return null;
        }
      }
      for (const eq of eqSet) {
        if (gt && !satisfies(eq, String(gt), options)) {
          return null;
        }
        if (lt && !satisfies(eq, String(lt), options)) {
          return null;
        }
        for (const c of dom) {
          if (!satisfies(eq, String(c), options)) {
            return false;
          }
        }
        return true;
      }
      let higher, lower;
      let hasDomLT, hasDomGT;
      let needDomLTPre = lt && !options.includePrerelease && lt.semver.prerelease.length ? lt.semver : false;
      let needDomGTPre = gt && !options.includePrerelease && gt.semver.prerelease.length ? gt.semver : false;
      if (needDomLTPre && needDomLTPre.prerelease.length === 1 && lt.operator === "<" && needDomLTPre.prerelease[0] === 0) {
        needDomLTPre = false;
      }
      for (const c of dom) {
        hasDomGT = hasDomGT || c.operator === ">" || c.operator === ">=";
        hasDomLT = hasDomLT || c.operator === "<" || c.operator === "<=";
        if (gt) {
          if (needDomGTPre) {
            if (c.semver.prerelease && c.semver.prerelease.length && c.semver.major === needDomGTPre.major && c.semver.minor === needDomGTPre.minor && c.semver.patch === needDomGTPre.patch) {
              needDomGTPre = false;
            }
          }
          if (c.operator === ">" || c.operator === ">=") {
            higher = higherGT(gt, c, options);
            if (higher === c && higher !== gt) {
              return false;
            }
          } else if (gt.operator === ">=" && !satisfies(gt.semver, String(c), options)) {
            return false;
          }
        }
        if (lt) {
          if (needDomLTPre) {
            if (c.semver.prerelease && c.semver.prerelease.length && c.semver.major === needDomLTPre.major && c.semver.minor === needDomLTPre.minor && c.semver.patch === needDomLTPre.patch) {
              needDomLTPre = false;
            }
          }
          if (c.operator === "<" || c.operator === "<=") {
            lower = lowerLT(lt, c, options);
            if (lower === c && lower !== lt) {
              return false;
            }
          } else if (lt.operator === "<=" && !satisfies(lt.semver, String(c), options)) {
            return false;
          }
        }
        if (!c.operator && (lt || gt) && gtltComp !== 0) {
          return false;
        }
      }
      if (gt && hasDomLT && !lt && gtltComp !== 0) {
        return false;
      }
      if (lt && hasDomGT && !gt && gtltComp !== 0) {
        return false;
      }
      if (needDomGTPre || needDomLTPre) {
        return false;
      }
      return true;
    };
    var higherGT = (a, b, options) => {
      if (!a) {
        return b;
      }
      const comp = compare(a.semver, b.semver, options);
      return comp > 0 ? a : comp < 0 ? b : b.operator === ">" && a.operator === ">=" ? b : a;
    };
    var lowerLT = (a, b, options) => {
      if (!a) {
        return b;
      }
      const comp = compare(a.semver, b.semver, options);
      return comp < 0 ? a : comp > 0 ? b : b.operator === "<" && a.operator === "<=" ? b : a;
    };
    module2.exports = subset;
  }
});

// node_modules/.pnpm/semver@7.7.4/node_modules/semver/index.js
var require_semver2 = __commonJS({
  "node_modules/.pnpm/semver@7.7.4/node_modules/semver/index.js"(exports2, module2) {
    "use strict";
    var internalRe = require_re();
    var constants = require_constants();
    var SemVer = require_semver();
    var identifiers = require_identifiers();
    var parse = require_parse();
    var valid = require_valid();
    var clean = require_clean();
    var inc = require_inc();
    var diff = require_diff();
    var major = require_major();
    var minor = require_minor();
    var patch = require_patch();
    var prerelease = require_prerelease();
    var compare = require_compare();
    var rcompare = require_rcompare();
    var compareLoose = require_compare_loose();
    var compareBuild = require_compare_build();
    var sort = require_sort();
    var rsort = require_rsort();
    var gt = require_gt();
    var lt = require_lt();
    var eq = require_eq();
    var neq = require_neq();
    var gte = require_gte();
    var lte = require_lte();
    var cmp = require_cmp();
    var coerce = require_coerce();
    var Comparator = require_comparator();
    var Range = require_range();
    var satisfies = require_satisfies();
    var toComparators = require_to_comparators();
    var maxSatisfying = require_max_satisfying();
    var minSatisfying = require_min_satisfying();
    var minVersion = require_min_version();
    var validRange = require_valid2();
    var outside = require_outside();
    var gtr = require_gtr();
    var ltr = require_ltr();
    var intersects = require_intersects();
    var simplifyRange = require_simplify();
    var subset = require_subset();
    module2.exports = {
      parse,
      valid,
      clean,
      inc,
      diff,
      major,
      minor,
      patch,
      prerelease,
      compare,
      rcompare,
      compareLoose,
      compareBuild,
      sort,
      rsort,
      gt,
      lt,
      eq,
      neq,
      gte,
      lte,
      cmp,
      coerce,
      Comparator,
      Range,
      satisfies,
      toComparators,
      maxSatisfying,
      minSatisfying,
      minVersion,
      validRange,
      outside,
      gtr,
      ltr,
      intersects,
      simplifyRange,
      subset,
      SemVer,
      re: internalRe.re,
      src: internalRe.src,
      tokens: internalRe.t,
      SEMVER_SPEC_VERSION: constants.SEMVER_SPEC_VERSION,
      RELEASE_TYPES: constants.RELEASE_TYPES,
      compareIdentifiers: identifiers.compareIdentifiers,
      rcompareIdentifiers: identifiers.rcompareIdentifiers
    };
  }
});

// node_modules/.pnpm/lodash.isequal@4.5.0/node_modules/lodash.isequal/index.js
var require_lodash = __commonJS({
  "node_modules/.pnpm/lodash.isequal@4.5.0/node_modules/lodash.isequal/index.js"(exports2, module2) {
    var LARGE_ARRAY_SIZE = 200;
    var HASH_UNDEFINED = "__lodash_hash_undefined__";
    var COMPARE_PARTIAL_FLAG = 1;
    var COMPARE_UNORDERED_FLAG = 2;
    var MAX_SAFE_INTEGER = 9007199254740991;
    var argsTag = "[object Arguments]";
    var arrayTag = "[object Array]";
    var asyncTag = "[object AsyncFunction]";
    var boolTag = "[object Boolean]";
    var dateTag = "[object Date]";
    var errorTag = "[object Error]";
    var funcTag = "[object Function]";
    var genTag = "[object GeneratorFunction]";
    var mapTag = "[object Map]";
    var numberTag = "[object Number]";
    var nullTag = "[object Null]";
    var objectTag = "[object Object]";
    var promiseTag = "[object Promise]";
    var proxyTag = "[object Proxy]";
    var regexpTag = "[object RegExp]";
    var setTag = "[object Set]";
    var stringTag = "[object String]";
    var symbolTag = "[object Symbol]";
    var undefinedTag = "[object Undefined]";
    var weakMapTag = "[object WeakMap]";
    var arrayBufferTag = "[object ArrayBuffer]";
    var dataViewTag = "[object DataView]";
    var float32Tag = "[object Float32Array]";
    var float64Tag = "[object Float64Array]";
    var int8Tag = "[object Int8Array]";
    var int16Tag = "[object Int16Array]";
    var int32Tag = "[object Int32Array]";
    var uint8Tag = "[object Uint8Array]";
    var uint8ClampedTag = "[object Uint8ClampedArray]";
    var uint16Tag = "[object Uint16Array]";
    var uint32Tag = "[object Uint32Array]";
    var reRegExpChar = /[\\^$.*+?()[\]{}|]/g;
    var reIsHostCtor = /^\[object .+?Constructor\]$/;
    var reIsUint = /^(?:0|[1-9]\d*)$/;
    var typedArrayTags = {};
    typedArrayTags[float32Tag] = typedArrayTags[float64Tag] = typedArrayTags[int8Tag] = typedArrayTags[int16Tag] = typedArrayTags[int32Tag] = typedArrayTags[uint8Tag] = typedArrayTags[uint8ClampedTag] = typedArrayTags[uint16Tag] = typedArrayTags[uint32Tag] = true;
    typedArrayTags[argsTag] = typedArrayTags[arrayTag] = typedArrayTags[arrayBufferTag] = typedArrayTags[boolTag] = typedArrayTags[dataViewTag] = typedArrayTags[dateTag] = typedArrayTags[errorTag] = typedArrayTags[funcTag] = typedArrayTags[mapTag] = typedArrayTags[numberTag] = typedArrayTags[objectTag] = typedArrayTags[regexpTag] = typedArrayTags[setTag] = typedArrayTags[stringTag] = typedArrayTags[weakMapTag] = false;
    var freeGlobal = typeof global == "object" && global && global.Object === Object && global;
    var freeSelf = typeof self == "object" && self && self.Object === Object && self;
    var root = freeGlobal || freeSelf || Function("return this")();
    var freeExports = typeof exports2 == "object" && exports2 && !exports2.nodeType && exports2;
    var freeModule = freeExports && typeof module2 == "object" && module2 && !module2.nodeType && module2;
    var moduleExports = freeModule && freeModule.exports === freeExports;
    var freeProcess = moduleExports && freeGlobal.process;
    var nodeUtil = (function() {
      try {
        return freeProcess && freeProcess.binding && freeProcess.binding("util");
      } catch (e) {
      }
    })();
    var nodeIsTypedArray = nodeUtil && nodeUtil.isTypedArray;
    function arrayFilter(array, predicate) {
      var index = -1, length = array == null ? 0 : array.length, resIndex = 0, result = [];
      while (++index < length) {
        var value = array[index];
        if (predicate(value, index, array)) {
          result[resIndex++] = value;
        }
      }
      return result;
    }
    function arrayPush(array, values) {
      var index = -1, length = values.length, offset = array.length;
      while (++index < length) {
        array[offset + index] = values[index];
      }
      return array;
    }
    function arraySome(array, predicate) {
      var index = -1, length = array == null ? 0 : array.length;
      while (++index < length) {
        if (predicate(array[index], index, array)) {
          return true;
        }
      }
      return false;
    }
    function baseTimes(n, iteratee) {
      var index = -1, result = Array(n);
      while (++index < n) {
        result[index] = iteratee(index);
      }
      return result;
    }
    function baseUnary(func) {
      return function(value) {
        return func(value);
      };
    }
    function cacheHas(cache, key) {
      return cache.has(key);
    }
    function getValue(object, key) {
      return object == null ? void 0 : object[key];
    }
    function mapToArray(map) {
      var index = -1, result = Array(map.size);
      map.forEach(function(value, key) {
        result[++index] = [key, value];
      });
      return result;
    }
    function overArg(func, transform) {
      return function(arg) {
        return func(transform(arg));
      };
    }
    function setToArray(set) {
      var index = -1, result = Array(set.size);
      set.forEach(function(value) {
        result[++index] = value;
      });
      return result;
    }
    var arrayProto = Array.prototype;
    var funcProto = Function.prototype;
    var objectProto = Object.prototype;
    var coreJsData = root["__core-js_shared__"];
    var funcToString = funcProto.toString;
    var hasOwnProperty = objectProto.hasOwnProperty;
    var maskSrcKey = (function() {
      var uid = /[^.]+$/.exec(coreJsData && coreJsData.keys && coreJsData.keys.IE_PROTO || "");
      return uid ? "Symbol(src)_1." + uid : "";
    })();
    var nativeObjectToString = objectProto.toString;
    var reIsNative = RegExp(
      "^" + funcToString.call(hasOwnProperty).replace(reRegExpChar, "\\$&").replace(/hasOwnProperty|(function).*?(?=\\\()| for .+?(?=\\\])/g, "$1.*?") + "$"
    );
    var Buffer2 = moduleExports ? root.Buffer : void 0;
    var Symbol2 = root.Symbol;
    var Uint8Array2 = root.Uint8Array;
    var propertyIsEnumerable = objectProto.propertyIsEnumerable;
    var splice = arrayProto.splice;
    var symToStringTag = Symbol2 ? Symbol2.toStringTag : void 0;
    var nativeGetSymbols = Object.getOwnPropertySymbols;
    var nativeIsBuffer = Buffer2 ? Buffer2.isBuffer : void 0;
    var nativeKeys = overArg(Object.keys, Object);
    var DataView = getNative(root, "DataView");
    var Map2 = getNative(root, "Map");
    var Promise2 = getNative(root, "Promise");
    var Set2 = getNative(root, "Set");
    var WeakMap = getNative(root, "WeakMap");
    var nativeCreate = getNative(Object, "create");
    var dataViewCtorString = toSource(DataView);
    var mapCtorString = toSource(Map2);
    var promiseCtorString = toSource(Promise2);
    var setCtorString = toSource(Set2);
    var weakMapCtorString = toSource(WeakMap);
    var symbolProto = Symbol2 ? Symbol2.prototype : void 0;
    var symbolValueOf = symbolProto ? symbolProto.valueOf : void 0;
    function Hash(entries) {
      var index = -1, length = entries == null ? 0 : entries.length;
      this.clear();
      while (++index < length) {
        var entry = entries[index];
        this.set(entry[0], entry[1]);
      }
    }
    function hashClear() {
      this.__data__ = nativeCreate ? nativeCreate(null) : {};
      this.size = 0;
    }
    function hashDelete(key) {
      var result = this.has(key) && delete this.__data__[key];
      this.size -= result ? 1 : 0;
      return result;
    }
    function hashGet(key) {
      var data = this.__data__;
      if (nativeCreate) {
        var result = data[key];
        return result === HASH_UNDEFINED ? void 0 : result;
      }
      return hasOwnProperty.call(data, key) ? data[key] : void 0;
    }
    function hashHas(key) {
      var data = this.__data__;
      return nativeCreate ? data[key] !== void 0 : hasOwnProperty.call(data, key);
    }
    function hashSet(key, value) {
      var data = this.__data__;
      this.size += this.has(key) ? 0 : 1;
      data[key] = nativeCreate && value === void 0 ? HASH_UNDEFINED : value;
      return this;
    }
    Hash.prototype.clear = hashClear;
    Hash.prototype["delete"] = hashDelete;
    Hash.prototype.get = hashGet;
    Hash.prototype.has = hashHas;
    Hash.prototype.set = hashSet;
    function ListCache(entries) {
      var index = -1, length = entries == null ? 0 : entries.length;
      this.clear();
      while (++index < length) {
        var entry = entries[index];
        this.set(entry[0], entry[1]);
      }
    }
    function listCacheClear() {
      this.__data__ = [];
      this.size = 0;
    }
    function listCacheDelete(key) {
      var data = this.__data__, index = assocIndexOf(data, key);
      if (index < 0) {
        return false;
      }
      var lastIndex = data.length - 1;
      if (index == lastIndex) {
        data.pop();
      } else {
        splice.call(data, index, 1);
      }
      --this.size;
      return true;
    }
    function listCacheGet(key) {
      var data = this.__data__, index = assocIndexOf(data, key);
      return index < 0 ? void 0 : data[index][1];
    }
    function listCacheHas(key) {
      return assocIndexOf(this.__data__, key) > -1;
    }
    function listCacheSet(key, value) {
      var data = this.__data__, index = assocIndexOf(data, key);
      if (index < 0) {
        ++this.size;
        data.push([key, value]);
      } else {
        data[index][1] = value;
      }
      return this;
    }
    ListCache.prototype.clear = listCacheClear;
    ListCache.prototype["delete"] = listCacheDelete;
    ListCache.prototype.get = listCacheGet;
    ListCache.prototype.has = listCacheHas;
    ListCache.prototype.set = listCacheSet;
    function MapCache(entries) {
      var index = -1, length = entries == null ? 0 : entries.length;
      this.clear();
      while (++index < length) {
        var entry = entries[index];
        this.set(entry[0], entry[1]);
      }
    }
    function mapCacheClear() {
      this.size = 0;
      this.__data__ = {
        "hash": new Hash(),
        "map": new (Map2 || ListCache)(),
        "string": new Hash()
      };
    }
    function mapCacheDelete(key) {
      var result = getMapData(this, key)["delete"](key);
      this.size -= result ? 1 : 0;
      return result;
    }
    function mapCacheGet(key) {
      return getMapData(this, key).get(key);
    }
    function mapCacheHas(key) {
      return getMapData(this, key).has(key);
    }
    function mapCacheSet(key, value) {
      var data = getMapData(this, key), size = data.size;
      data.set(key, value);
      this.size += data.size == size ? 0 : 1;
      return this;
    }
    MapCache.prototype.clear = mapCacheClear;
    MapCache.prototype["delete"] = mapCacheDelete;
    MapCache.prototype.get = mapCacheGet;
    MapCache.prototype.has = mapCacheHas;
    MapCache.prototype.set = mapCacheSet;
    function SetCache(values) {
      var index = -1, length = values == null ? 0 : values.length;
      this.__data__ = new MapCache();
      while (++index < length) {
        this.add(values[index]);
      }
    }
    function setCacheAdd(value) {
      this.__data__.set(value, HASH_UNDEFINED);
      return this;
    }
    function setCacheHas(value) {
      return this.__data__.has(value);
    }
    SetCache.prototype.add = SetCache.prototype.push = setCacheAdd;
    SetCache.prototype.has = setCacheHas;
    function Stack(entries) {
      var data = this.__data__ = new ListCache(entries);
      this.size = data.size;
    }
    function stackClear() {
      this.__data__ = new ListCache();
      this.size = 0;
    }
    function stackDelete(key) {
      var data = this.__data__, result = data["delete"](key);
      this.size = data.size;
      return result;
    }
    function stackGet(key) {
      return this.__data__.get(key);
    }
    function stackHas(key) {
      return this.__data__.has(key);
    }
    function stackSet(key, value) {
      var data = this.__data__;
      if (data instanceof ListCache) {
        var pairs = data.__data__;
        if (!Map2 || pairs.length < LARGE_ARRAY_SIZE - 1) {
          pairs.push([key, value]);
          this.size = ++data.size;
          return this;
        }
        data = this.__data__ = new MapCache(pairs);
      }
      data.set(key, value);
      this.size = data.size;
      return this;
    }
    Stack.prototype.clear = stackClear;
    Stack.prototype["delete"] = stackDelete;
    Stack.prototype.get = stackGet;
    Stack.prototype.has = stackHas;
    Stack.prototype.set = stackSet;
    function arrayLikeKeys(value, inherited) {
      var isArr = isArray(value), isArg = !isArr && isArguments(value), isBuff = !isArr && !isArg && isBuffer(value), isType = !isArr && !isArg && !isBuff && isTypedArray(value), skipIndexes = isArr || isArg || isBuff || isType, result = skipIndexes ? baseTimes(value.length, String) : [], length = result.length;
      for (var key in value) {
        if ((inherited || hasOwnProperty.call(value, key)) && !(skipIndexes && // Safari 9 has enumerable `arguments.length` in strict mode.
        (key == "length" || // Node.js 0.10 has enumerable non-index properties on buffers.
        isBuff && (key == "offset" || key == "parent") || // PhantomJS 2 has enumerable non-index properties on typed arrays.
        isType && (key == "buffer" || key == "byteLength" || key == "byteOffset") || // Skip index properties.
        isIndex(key, length)))) {
          result.push(key);
        }
      }
      return result;
    }
    function assocIndexOf(array, key) {
      var length = array.length;
      while (length--) {
        if (eq(array[length][0], key)) {
          return length;
        }
      }
      return -1;
    }
    function baseGetAllKeys(object, keysFunc, symbolsFunc) {
      var result = keysFunc(object);
      return isArray(object) ? result : arrayPush(result, symbolsFunc(object));
    }
    function baseGetTag(value) {
      if (value == null) {
        return value === void 0 ? undefinedTag : nullTag;
      }
      return symToStringTag && symToStringTag in Object(value) ? getRawTag(value) : objectToString(value);
    }
    function baseIsArguments(value) {
      return isObjectLike(value) && baseGetTag(value) == argsTag;
    }
    function baseIsEqual(value, other, bitmask, customizer, stack) {
      if (value === other) {
        return true;
      }
      if (value == null || other == null || !isObjectLike(value) && !isObjectLike(other)) {
        return value !== value && other !== other;
      }
      return baseIsEqualDeep(value, other, bitmask, customizer, baseIsEqual, stack);
    }
    function baseIsEqualDeep(object, other, bitmask, customizer, equalFunc, stack) {
      var objIsArr = isArray(object), othIsArr = isArray(other), objTag = objIsArr ? arrayTag : getTag(object), othTag = othIsArr ? arrayTag : getTag(other);
      objTag = objTag == argsTag ? objectTag : objTag;
      othTag = othTag == argsTag ? objectTag : othTag;
      var objIsObj = objTag == objectTag, othIsObj = othTag == objectTag, isSameTag = objTag == othTag;
      if (isSameTag && isBuffer(object)) {
        if (!isBuffer(other)) {
          return false;
        }
        objIsArr = true;
        objIsObj = false;
      }
      if (isSameTag && !objIsObj) {
        stack || (stack = new Stack());
        return objIsArr || isTypedArray(object) ? equalArrays(object, other, bitmask, customizer, equalFunc, stack) : equalByTag(object, other, objTag, bitmask, customizer, equalFunc, stack);
      }
      if (!(bitmask & COMPARE_PARTIAL_FLAG)) {
        var objIsWrapped = objIsObj && hasOwnProperty.call(object, "__wrapped__"), othIsWrapped = othIsObj && hasOwnProperty.call(other, "__wrapped__");
        if (objIsWrapped || othIsWrapped) {
          var objUnwrapped = objIsWrapped ? object.value() : object, othUnwrapped = othIsWrapped ? other.value() : other;
          stack || (stack = new Stack());
          return equalFunc(objUnwrapped, othUnwrapped, bitmask, customizer, stack);
        }
      }
      if (!isSameTag) {
        return false;
      }
      stack || (stack = new Stack());
      return equalObjects(object, other, bitmask, customizer, equalFunc, stack);
    }
    function baseIsNative(value) {
      if (!isObject(value) || isMasked(value)) {
        return false;
      }
      var pattern = isFunction(value) ? reIsNative : reIsHostCtor;
      return pattern.test(toSource(value));
    }
    function baseIsTypedArray(value) {
      return isObjectLike(value) && isLength(value.length) && !!typedArrayTags[baseGetTag(value)];
    }
    function baseKeys(object) {
      if (!isPrototype(object)) {
        return nativeKeys(object);
      }
      var result = [];
      for (var key in Object(object)) {
        if (hasOwnProperty.call(object, key) && key != "constructor") {
          result.push(key);
        }
      }
      return result;
    }
    function equalArrays(array, other, bitmask, customizer, equalFunc, stack) {
      var isPartial = bitmask & COMPARE_PARTIAL_FLAG, arrLength = array.length, othLength = other.length;
      if (arrLength != othLength && !(isPartial && othLength > arrLength)) {
        return false;
      }
      var stacked = stack.get(array);
      if (stacked && stack.get(other)) {
        return stacked == other;
      }
      var index = -1, result = true, seen = bitmask & COMPARE_UNORDERED_FLAG ? new SetCache() : void 0;
      stack.set(array, other);
      stack.set(other, array);
      while (++index < arrLength) {
        var arrValue = array[index], othValue = other[index];
        if (customizer) {
          var compared = isPartial ? customizer(othValue, arrValue, index, other, array, stack) : customizer(arrValue, othValue, index, array, other, stack);
        }
        if (compared !== void 0) {
          if (compared) {
            continue;
          }
          result = false;
          break;
        }
        if (seen) {
          if (!arraySome(other, function(othValue2, othIndex) {
            if (!cacheHas(seen, othIndex) && (arrValue === othValue2 || equalFunc(arrValue, othValue2, bitmask, customizer, stack))) {
              return seen.push(othIndex);
            }
          })) {
            result = false;
            break;
          }
        } else if (!(arrValue === othValue || equalFunc(arrValue, othValue, bitmask, customizer, stack))) {
          result = false;
          break;
        }
      }
      stack["delete"](array);
      stack["delete"](other);
      return result;
    }
    function equalByTag(object, other, tag, bitmask, customizer, equalFunc, stack) {
      switch (tag) {
        case dataViewTag:
          if (object.byteLength != other.byteLength || object.byteOffset != other.byteOffset) {
            return false;
          }
          object = object.buffer;
          other = other.buffer;
        case arrayBufferTag:
          if (object.byteLength != other.byteLength || !equalFunc(new Uint8Array2(object), new Uint8Array2(other))) {
            return false;
          }
          return true;
        case boolTag:
        case dateTag:
        case numberTag:
          return eq(+object, +other);
        case errorTag:
          return object.name == other.name && object.message == other.message;
        case regexpTag:
        case stringTag:
          return object == other + "";
        case mapTag:
          var convert = mapToArray;
        case setTag:
          var isPartial = bitmask & COMPARE_PARTIAL_FLAG;
          convert || (convert = setToArray);
          if (object.size != other.size && !isPartial) {
            return false;
          }
          var stacked = stack.get(object);
          if (stacked) {
            return stacked == other;
          }
          bitmask |= COMPARE_UNORDERED_FLAG;
          stack.set(object, other);
          var result = equalArrays(convert(object), convert(other), bitmask, customizer, equalFunc, stack);
          stack["delete"](object);
          return result;
        case symbolTag:
          if (symbolValueOf) {
            return symbolValueOf.call(object) == symbolValueOf.call(other);
          }
      }
      return false;
    }
    function equalObjects(object, other, bitmask, customizer, equalFunc, stack) {
      var isPartial = bitmask & COMPARE_PARTIAL_FLAG, objProps = getAllKeys(object), objLength = objProps.length, othProps = getAllKeys(other), othLength = othProps.length;
      if (objLength != othLength && !isPartial) {
        return false;
      }
      var index = objLength;
      while (index--) {
        var key = objProps[index];
        if (!(isPartial ? key in other : hasOwnProperty.call(other, key))) {
          return false;
        }
      }
      var stacked = stack.get(object);
      if (stacked && stack.get(other)) {
        return stacked == other;
      }
      var result = true;
      stack.set(object, other);
      stack.set(other, object);
      var skipCtor = isPartial;
      while (++index < objLength) {
        key = objProps[index];
        var objValue = object[key], othValue = other[key];
        if (customizer) {
          var compared = isPartial ? customizer(othValue, objValue, key, other, object, stack) : customizer(objValue, othValue, key, object, other, stack);
        }
        if (!(compared === void 0 ? objValue === othValue || equalFunc(objValue, othValue, bitmask, customizer, stack) : compared)) {
          result = false;
          break;
        }
        skipCtor || (skipCtor = key == "constructor");
      }
      if (result && !skipCtor) {
        var objCtor = object.constructor, othCtor = other.constructor;
        if (objCtor != othCtor && ("constructor" in object && "constructor" in other) && !(typeof objCtor == "function" && objCtor instanceof objCtor && typeof othCtor == "function" && othCtor instanceof othCtor)) {
          result = false;
        }
      }
      stack["delete"](object);
      stack["delete"](other);
      return result;
    }
    function getAllKeys(object) {
      return baseGetAllKeys(object, keys, getSymbols);
    }
    function getMapData(map, key) {
      var data = map.__data__;
      return isKeyable(key) ? data[typeof key == "string" ? "string" : "hash"] : data.map;
    }
    function getNative(object, key) {
      var value = getValue(object, key);
      return baseIsNative(value) ? value : void 0;
    }
    function getRawTag(value) {
      var isOwn = hasOwnProperty.call(value, symToStringTag), tag = value[symToStringTag];
      try {
        value[symToStringTag] = void 0;
        var unmasked = true;
      } catch (e) {
      }
      var result = nativeObjectToString.call(value);
      if (unmasked) {
        if (isOwn) {
          value[symToStringTag] = tag;
        } else {
          delete value[symToStringTag];
        }
      }
      return result;
    }
    var getSymbols = !nativeGetSymbols ? stubArray : function(object) {
      if (object == null) {
        return [];
      }
      object = Object(object);
      return arrayFilter(nativeGetSymbols(object), function(symbol) {
        return propertyIsEnumerable.call(object, symbol);
      });
    };
    var getTag = baseGetTag;
    if (DataView && getTag(new DataView(new ArrayBuffer(1))) != dataViewTag || Map2 && getTag(new Map2()) != mapTag || Promise2 && getTag(Promise2.resolve()) != promiseTag || Set2 && getTag(new Set2()) != setTag || WeakMap && getTag(new WeakMap()) != weakMapTag) {
      getTag = function(value) {
        var result = baseGetTag(value), Ctor = result == objectTag ? value.constructor : void 0, ctorString = Ctor ? toSource(Ctor) : "";
        if (ctorString) {
          switch (ctorString) {
            case dataViewCtorString:
              return dataViewTag;
            case mapCtorString:
              return mapTag;
            case promiseCtorString:
              return promiseTag;
            case setCtorString:
              return setTag;
            case weakMapCtorString:
              return weakMapTag;
          }
        }
        return result;
      };
    }
    function isIndex(value, length) {
      length = length == null ? MAX_SAFE_INTEGER : length;
      return !!length && (typeof value == "number" || reIsUint.test(value)) && (value > -1 && value % 1 == 0 && value < length);
    }
    function isKeyable(value) {
      var type = typeof value;
      return type == "string" || type == "number" || type == "symbol" || type == "boolean" ? value !== "__proto__" : value === null;
    }
    function isMasked(func) {
      return !!maskSrcKey && maskSrcKey in func;
    }
    function isPrototype(value) {
      var Ctor = value && value.constructor, proto = typeof Ctor == "function" && Ctor.prototype || objectProto;
      return value === proto;
    }
    function objectToString(value) {
      return nativeObjectToString.call(value);
    }
    function toSource(func) {
      if (func != null) {
        try {
          return funcToString.call(func);
        } catch (e) {
        }
        try {
          return func + "";
        } catch (e) {
        }
      }
      return "";
    }
    function eq(value, other) {
      return value === other || value !== value && other !== other;
    }
    var isArguments = baseIsArguments(/* @__PURE__ */ (function() {
      return arguments;
    })()) ? baseIsArguments : function(value) {
      return isObjectLike(value) && hasOwnProperty.call(value, "callee") && !propertyIsEnumerable.call(value, "callee");
    };
    var isArray = Array.isArray;
    function isArrayLike(value) {
      return value != null && isLength(value.length) && !isFunction(value);
    }
    var isBuffer = nativeIsBuffer || stubFalse;
    function isEqual(value, other) {
      return baseIsEqual(value, other);
    }
    function isFunction(value) {
      if (!isObject(value)) {
        return false;
      }
      var tag = baseGetTag(value);
      return tag == funcTag || tag == genTag || tag == asyncTag || tag == proxyTag;
    }
    function isLength(value) {
      return typeof value == "number" && value > -1 && value % 1 == 0 && value <= MAX_SAFE_INTEGER;
    }
    function isObject(value) {
      var type = typeof value;
      return value != null && (type == "object" || type == "function");
    }
    function isObjectLike(value) {
      return value != null && typeof value == "object";
    }
    var isTypedArray = nodeIsTypedArray ? baseUnary(nodeIsTypedArray) : baseIsTypedArray;
    function keys(object) {
      return isArrayLike(object) ? arrayLikeKeys(object) : baseKeys(object);
    }
    function stubArray() {
      return [];
    }
    function stubFalse() {
      return false;
    }
    module2.exports = isEqual;
  }
});

// node_modules/.pnpm/electron-updater@6.8.9/node_modules/electron-updater/out/DownloadedUpdateHelper.js
var require_DownloadedUpdateHelper = __commonJS({
  "node_modules/.pnpm/electron-updater@6.8.9/node_modules/electron-updater/out/DownloadedUpdateHelper.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.DownloadedUpdateHelper = void 0;
    exports2.createTempUpdateFile = createTempUpdateFile;
    var crypto_1 = require("crypto");
    var fs_1 = require("fs");
    var isEqual = require_lodash();
    var fs_extra_12 = require_lib();
    var path2 = require("path");
    var DownloadedUpdateHelper = class {
      constructor(cacheDir) {
        this.cacheDir = cacheDir;
        this._file = null;
        this._packageFile = null;
        this.versionInfo = null;
        this.fileInfo = null;
        this._downloadedFileInfo = null;
      }
      get downloadedFileInfo() {
        return this._downloadedFileInfo;
      }
      get file() {
        return this._file;
      }
      get packageFile() {
        return this._packageFile;
      }
      get cacheDirForPendingUpdate() {
        return path2.join(this.cacheDir, "pending");
      }
      async validateDownloadedPath(updateFile, updateInfo, fileInfo, logger) {
        if (this.versionInfo != null && this.file === updateFile && this.fileInfo != null) {
          if (isEqual(this.versionInfo, updateInfo) && isEqual(this.fileInfo.info, fileInfo.info) && await (0, fs_extra_12.pathExists)(updateFile)) {
            return updateFile;
          } else {
            return null;
          }
        }
        const cachedUpdateFile = await this.getValidCachedUpdateFile(fileInfo, logger);
        if (cachedUpdateFile === null) {
          return null;
        }
        logger.info(`Update has already been downloaded to ${updateFile}).`);
        this._file = cachedUpdateFile;
        return cachedUpdateFile;
      }
      async setDownloadedFile(downloadedFile, packageFile, versionInfo, fileInfo, updateFileName, isSaveCache) {
        this._file = downloadedFile;
        this._packageFile = packageFile;
        this.versionInfo = versionInfo;
        this.fileInfo = fileInfo;
        this._downloadedFileInfo = {
          fileName: updateFileName,
          sha512: fileInfo.info.sha512,
          isAdminRightsRequired: fileInfo.info.isAdminRightsRequired === true
        };
        if (isSaveCache) {
          await (0, fs_extra_12.outputJson)(this.getUpdateInfoFile(), this._downloadedFileInfo);
        }
      }
      async clear() {
        this._file = null;
        this._packageFile = null;
        this.versionInfo = null;
        this.fileInfo = null;
        await this.cleanCacheDirForPendingUpdate();
      }
      async cleanCacheDirForPendingUpdate() {
        try {
          await (0, fs_extra_12.emptyDir)(this.cacheDirForPendingUpdate);
        } catch (_ignore) {
        }
      }
      /**
       * Returns "update-info.json" which is created in the update cache directory's "pending" subfolder after the first update is downloaded.  If the update file does not exist then the cache is cleared and recreated.  If the update file exists then its properties are validated.
       * @param fileInfo
       * @param logger
       */
      async getValidCachedUpdateFile(fileInfo, logger) {
        const updateInfoFilePath = this.getUpdateInfoFile();
        const doesUpdateInfoFileExist = await (0, fs_extra_12.pathExists)(updateInfoFilePath);
        if (!doesUpdateInfoFileExist) {
          return null;
        }
        let cachedInfo;
        try {
          cachedInfo = await (0, fs_extra_12.readJson)(updateInfoFilePath);
        } catch (error) {
          let message = `No cached update info available`;
          if (error.code !== "ENOENT") {
            await this.cleanCacheDirForPendingUpdate();
            message += ` (error on read: ${error.message})`;
          }
          logger.info(message);
          return null;
        }
        const isCachedInfoFileNameValid = (cachedInfo === null || cachedInfo === void 0 ? void 0 : cachedInfo.fileName) !== null;
        if (!isCachedInfoFileNameValid) {
          logger.warn(`Cached update info is corrupted: no fileName, directory for cached update will be cleaned`);
          await this.cleanCacheDirForPendingUpdate();
          return null;
        }
        if (fileInfo.info.sha512 !== cachedInfo.sha512) {
          logger.info(`Cached update sha512 checksum doesn't match the latest available update. New update must be downloaded. Cached: ${cachedInfo.sha512}, expected: ${fileInfo.info.sha512}. Directory for cached update will be cleaned`);
          await this.cleanCacheDirForPendingUpdate();
          return null;
        }
        const updateFile = path2.join(this.cacheDirForPendingUpdate, cachedInfo.fileName);
        if (!await (0, fs_extra_12.pathExists)(updateFile)) {
          logger.info("Cached update file doesn't exist");
          return null;
        }
        const sha512 = await hashFile(updateFile);
        if (fileInfo.info.sha512 !== sha512) {
          logger.warn(`Sha512 checksum doesn't match the latest available update. New update must be downloaded. Cached: ${sha512}, expected: ${fileInfo.info.sha512}`);
          await this.cleanCacheDirForPendingUpdate();
          return null;
        }
        this._downloadedFileInfo = cachedInfo;
        return updateFile;
      }
      getUpdateInfoFile() {
        return path2.join(this.cacheDirForPendingUpdate, "update-info.json");
      }
    };
    exports2.DownloadedUpdateHelper = DownloadedUpdateHelper;
    function hashFile(file, algorithm = "sha512", encoding = "base64", options) {
      return new Promise((resolve, reject) => {
        const hash = (0, crypto_1.createHash)(algorithm);
        hash.on("error", reject).setEncoding(encoding);
        (0, fs_1.createReadStream)(file, {
          ...options,
          highWaterMark: 1024 * 1024
          /* better to use more memory but hash faster */
        }).on("error", reject).on("end", () => {
          hash.end();
          resolve(hash.read());
        }).pipe(hash, { end: false });
      });
    }
    async function createTempUpdateFile(name, cacheDir, log) {
      let nameCounter = 0;
      let result = path2.join(cacheDir, name);
      for (let i = 0; i < 3; i++) {
        try {
          await (0, fs_extra_12.unlink)(result);
          return result;
        } catch (e) {
          if (e.code === "ENOENT") {
            return result;
          }
          log.warn(`Error on remove temp update file: ${e}`);
          result = path2.join(cacheDir, `${nameCounter++}-${name}`);
        }
      }
      return result;
    }
  }
});

// node_modules/.pnpm/electron-updater@6.8.9/node_modules/electron-updater/out/AppAdapter.js
var require_AppAdapter = __commonJS({
  "node_modules/.pnpm/electron-updater@6.8.9/node_modules/electron-updater/out/AppAdapter.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.getAppCacheDir = getAppCacheDir;
    var path2 = require("path");
    var os_1 = require("os");
    function getAppCacheDir() {
      const homedir = (0, os_1.homedir)();
      let result;
      if (process.platform === "win32") {
        result = process.env["LOCALAPPDATA"] || path2.join(homedir, "AppData", "Local");
      } else if (process.platform === "darwin") {
        result = path2.join(homedir, "Library", "Caches");
      } else {
        result = process.env["XDG_CACHE_HOME"] || path2.join(homedir, ".cache");
      }
      return result;
    }
  }
});

// node_modules/.pnpm/electron-updater@6.8.9/node_modules/electron-updater/out/ElectronAppAdapter.js
var require_ElectronAppAdapter = __commonJS({
  "node_modules/.pnpm/electron-updater@6.8.9/node_modules/electron-updater/out/ElectronAppAdapter.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.ElectronAppAdapter = void 0;
    var path2 = require("path");
    var AppAdapter_1 = require_AppAdapter();
    var ElectronAppAdapter = class {
      constructor(app = require("electron").app) {
        this.app = app;
      }
      whenReady() {
        return this.app.whenReady();
      }
      get version() {
        return this.app.getVersion();
      }
      get name() {
        return this.app.getName();
      }
      get isPackaged() {
        return this.app.isPackaged === true;
      }
      get appUpdateConfigPath() {
        return this.isPackaged ? path2.join(process.resourcesPath, "app-update.yml") : path2.join(this.app.getAppPath(), "dev-app-update.yml");
      }
      get userDataPath() {
        return this.app.getPath("userData");
      }
      get baseCachePath() {
        return (0, AppAdapter_1.getAppCacheDir)();
      }
      quit() {
        this.app.quit();
      }
      relaunch() {
        this.app.relaunch();
      }
      onQuit(handler) {
        this.app.once("quit", (_, exitCode) => handler(exitCode));
      }
    };
    exports2.ElectronAppAdapter = ElectronAppAdapter;
  }
});

// node_modules/.pnpm/electron-updater@6.8.9/node_modules/electron-updater/out/electronHttpExecutor.js
var require_electronHttpExecutor = __commonJS({
  "node_modules/.pnpm/electron-updater@6.8.9/node_modules/electron-updater/out/electronHttpExecutor.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.ElectronHttpExecutor = exports2.NET_SESSION_NAME = void 0;
    exports2.getNetSession = getNetSession;
    var builder_util_runtime_1 = require_out();
    exports2.NET_SESSION_NAME = "electron-updater";
    function getNetSession() {
      return require("electron").session.fromPartition(exports2.NET_SESSION_NAME, {
        cache: false
      });
    }
    var ElectronHttpExecutor = class extends builder_util_runtime_1.HttpExecutor {
      constructor(proxyLoginCallback) {
        super();
        this.proxyLoginCallback = proxyLoginCallback;
        this.cachedSession = null;
      }
      async download(url, destination, options) {
        return await options.cancellationToken.createPromise((resolve, reject, onCancel) => {
          const requestOptions = {
            headers: options.headers || void 0,
            redirect: "manual"
          };
          (0, builder_util_runtime_1.configureRequestUrl)(url, requestOptions);
          (0, builder_util_runtime_1.configureRequestOptions)(requestOptions);
          this.doDownload(requestOptions, {
            destination,
            options,
            onCancel,
            callback: (error) => {
              if (error == null) {
                resolve(destination);
              } else {
                reject(error);
              }
            },
            responseHandler: null
          }, 0);
        });
      }
      createRequest(options, callback) {
        if (options.headers && options.headers.Host) {
          options.host = options.headers.Host;
          delete options.headers.Host;
        }
        if (this.cachedSession == null) {
          this.cachedSession = getNetSession();
        }
        const request = require("electron").net.request({
          ...options,
          session: this.cachedSession
        });
        request.on("response", callback);
        if (this.proxyLoginCallback != null) {
          request.on("login", this.proxyLoginCallback);
        }
        return request;
      }
      addRedirectHandlers(request, options, reject, redirectCount, handler) {
        request.on("redirect", (statusCode, method, redirectUrl) => {
          request.abort();
          if (redirectCount > this.maxRedirects) {
            reject(this.createMaxRedirectError());
          } else {
            handler(builder_util_runtime_1.HttpExecutor.prepareRedirectUrlOptions(redirectUrl, options));
          }
        });
      }
    };
    exports2.ElectronHttpExecutor = ElectronHttpExecutor;
  }
});

// node_modules/.pnpm/electron-updater@6.8.9/node_modules/electron-updater/out/util.js
var require_util = __commonJS({
  "node_modules/.pnpm/electron-updater@6.8.9/node_modules/electron-updater/out/util.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.newBaseUrl = newBaseUrl;
    exports2.newUrlFromBase = newUrlFromBase;
    exports2.getChannelFilename = getChannelFilename;
    var url_1 = require("url");
    function newBaseUrl(url) {
      const result = new url_1.URL(url);
      if (!result.pathname.endsWith("/")) {
        result.pathname += "/";
      }
      return result;
    }
    function newUrlFromBase(pathname, baseUrl, addRandomQueryToAvoidCaching = false) {
      const result = new url_1.URL(pathname, baseUrl);
      const search = baseUrl.search;
      if (search != null && search.length !== 0) {
        result.search = search;
      } else if (addRandomQueryToAvoidCaching) {
        result.search = `noCache=${Date.now().toString(32)}`;
      }
      return result;
    }
    function getChannelFilename(channel) {
      return `${channel}.yml`;
    }
  }
});

// node_modules/.pnpm/lodash.escaperegexp@4.1.2/node_modules/lodash.escaperegexp/index.js
var require_lodash2 = __commonJS({
  "node_modules/.pnpm/lodash.escaperegexp@4.1.2/node_modules/lodash.escaperegexp/index.js"(exports2, module2) {
    var INFINITY = 1 / 0;
    var symbolTag = "[object Symbol]";
    var reRegExpChar = /[\\^$.*+?()[\]{}|]/g;
    var reHasRegExpChar = RegExp(reRegExpChar.source);
    var freeGlobal = typeof global == "object" && global && global.Object === Object && global;
    var freeSelf = typeof self == "object" && self && self.Object === Object && self;
    var root = freeGlobal || freeSelf || Function("return this")();
    var objectProto = Object.prototype;
    var objectToString = objectProto.toString;
    var Symbol2 = root.Symbol;
    var symbolProto = Symbol2 ? Symbol2.prototype : void 0;
    var symbolToString = symbolProto ? symbolProto.toString : void 0;
    function baseToString(value) {
      if (typeof value == "string") {
        return value;
      }
      if (isSymbol(value)) {
        return symbolToString ? symbolToString.call(value) : "";
      }
      var result = value + "";
      return result == "0" && 1 / value == -INFINITY ? "-0" : result;
    }
    function isObjectLike(value) {
      return !!value && typeof value == "object";
    }
    function isSymbol(value) {
      return typeof value == "symbol" || isObjectLike(value) && objectToString.call(value) == symbolTag;
    }
    function toString(value) {
      return value == null ? "" : baseToString(value);
    }
    function escapeRegExp(string) {
      string = toString(string);
      return string && reHasRegExpChar.test(string) ? string.replace(reRegExpChar, "\\$&") : string;
    }
    module2.exports = escapeRegExp;
  }
});

// node_modules/.pnpm/electron-updater@6.8.9/node_modules/electron-updater/out/providers/Provider.js
var require_Provider = __commonJS({
  "node_modules/.pnpm/electron-updater@6.8.9/node_modules/electron-updater/out/providers/Provider.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.Provider = void 0;
    exports2.findFile = findFile;
    exports2.parseUpdateInfo = parseUpdateInfo;
    exports2.getFileList = getFileList;
    exports2.resolveFiles = resolveFiles;
    var builder_util_runtime_1 = require_out();
    var js_yaml_1 = require_js_yaml_cjs();
    var url_1 = require("url");
    var util_1 = require_util();
    var escapeRegExp = require_lodash2();
    var Provider = class {
      constructor(runtimeOptions) {
        this.runtimeOptions = runtimeOptions;
        this.requestHeaders = null;
        this.executor = runtimeOptions.executor;
      }
      // By default, the blockmap file is in the same directory as the main file
      // But some providers may have a different blockmap file, so we need to override this method
      getBlockMapFiles(baseUrl, oldVersion, newVersion, oldBlockMapFileBaseUrl = null) {
        const newBlockMapUrl = (0, util_1.newUrlFromBase)(`${baseUrl.pathname}.blockmap`, baseUrl);
        const oldBlockMapUrl = (0, util_1.newUrlFromBase)(`${baseUrl.pathname.replace(new RegExp(escapeRegExp(newVersion), "g"), oldVersion)}.blockmap`, oldBlockMapFileBaseUrl ? new url_1.URL(oldBlockMapFileBaseUrl) : baseUrl);
        return [oldBlockMapUrl, newBlockMapUrl];
      }
      get isUseMultipleRangeRequest() {
        return this.runtimeOptions.isUseMultipleRangeRequest !== false;
      }
      getChannelFilePrefix() {
        if (this.runtimeOptions.platform === "linux") {
          const arch = process.env["TEST_UPDATER_ARCH"] || process.arch;
          const archSuffix = arch === "x64" ? "" : `-${arch}`;
          return "-linux" + archSuffix;
        } else {
          return this.runtimeOptions.platform === "darwin" ? "-mac" : "";
        }
      }
      // due to historical reasons for windows we use channel name without platform specifier
      getDefaultChannelName() {
        return this.getCustomChannelName("latest");
      }
      getCustomChannelName(channel) {
        return `${channel}${this.getChannelFilePrefix()}`;
      }
      get fileExtraDownloadHeaders() {
        return null;
      }
      setRequestHeaders(value) {
        this.requestHeaders = value;
      }
      /**
       * Method to perform API request only to resolve update info, but not to download update.
       */
      httpRequest(url, headers, cancellationToken) {
        return this.executor.request(this.createRequestOptions(url, headers), cancellationToken);
      }
      createRequestOptions(url, headers) {
        const result = {};
        if (this.requestHeaders == null) {
          if (headers != null) {
            result.headers = headers;
          }
        } else {
          result.headers = headers == null ? this.requestHeaders : { ...this.requestHeaders, ...headers };
        }
        (0, builder_util_runtime_1.configureRequestUrl)(url, result);
        return result;
      }
    };
    exports2.Provider = Provider;
    function findFile(files, extension, not) {
      var _a;
      if (files.length === 0) {
        throw (0, builder_util_runtime_1.newError)("No files provided", "ERR_UPDATER_NO_FILES_PROVIDED");
      }
      const filteredFiles = files.filter((it) => it.url.pathname.toLowerCase().endsWith(`.${extension.toLowerCase()}`));
      const result = (_a = filteredFiles.find((it) => [it.url.pathname, it.info.url].some((n) => n.includes(process.arch)))) !== null && _a !== void 0 ? _a : filteredFiles.shift();
      if (result) {
        return result;
      } else if (not == null) {
        return files[0];
      } else {
        return files.find((fileInfo) => !not.some((ext) => fileInfo.url.pathname.toLowerCase().endsWith(`.${ext.toLowerCase()}`)));
      }
    }
    function parseUpdateInfo(rawData, channelFile, channelFileUrl) {
      if (rawData == null) {
        throw (0, builder_util_runtime_1.newError)(`Cannot parse update info from ${channelFile} in the latest release artifacts (${channelFileUrl}): rawData: null`, "ERR_UPDATER_INVALID_UPDATE_INFO");
      }
      let result;
      try {
        result = (0, js_yaml_1.load)(rawData);
      } catch (e) {
        throw (0, builder_util_runtime_1.newError)(`Cannot parse update info from ${channelFile} in the latest release artifacts (${channelFileUrl}): ${e.stack || e.message}, rawData: ${rawData}`, "ERR_UPDATER_INVALID_UPDATE_INFO");
      }
      return result;
    }
    function getFileList(updateInfo) {
      const files = updateInfo.files;
      if (files != null && files.length > 0) {
        return files;
      }
      if (updateInfo.path != null) {
        return [
          {
            url: updateInfo.path,
            sha2: updateInfo.sha2,
            sha512: updateInfo.sha512
          }
        ];
      } else {
        throw (0, builder_util_runtime_1.newError)(`No files provided: ${(0, builder_util_runtime_1.safeStringifyJson)(updateInfo)}`, "ERR_UPDATER_NO_FILES_PROVIDED");
      }
    }
    function resolveFiles(updateInfo, baseUrl, pathTransformer = (p) => p) {
      const files = getFileList(updateInfo);
      const result = files.map((fileInfo) => {
        if (fileInfo.sha2 == null && fileInfo.sha512 == null) {
          throw (0, builder_util_runtime_1.newError)(`Update info doesn't contain nor sha256 neither sha512 checksum: ${(0, builder_util_runtime_1.safeStringifyJson)(fileInfo)}`, "ERR_UPDATER_NO_CHECKSUM");
        }
        return {
          url: (0, util_1.newUrlFromBase)(pathTransformer(fileInfo.url), baseUrl),
          info: fileInfo
        };
      });
      const packages = updateInfo.packages;
      const packageInfo = packages == null ? null : packages[process.arch] || packages.ia32;
      if (packageInfo != null) {
        ;
        result[0].packageInfo = {
          ...packageInfo,
          path: (0, util_1.newUrlFromBase)(pathTransformer(packageInfo.path), baseUrl).href
        };
      }
      return result;
    }
  }
});

// node_modules/.pnpm/electron-updater@6.8.9/node_modules/electron-updater/out/providers/GenericProvider.js
var require_GenericProvider = __commonJS({
  "node_modules/.pnpm/electron-updater@6.8.9/node_modules/electron-updater/out/providers/GenericProvider.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.GenericProvider = void 0;
    var builder_util_runtime_1 = require_out();
    var util_1 = require_util();
    var Provider_12 = require_Provider();
    var GenericProvider = class extends Provider_12.Provider {
      constructor(configuration, updater, runtimeOptions) {
        super(runtimeOptions);
        this.configuration = configuration;
        this.updater = updater;
        this.baseUrl = (0, util_1.newBaseUrl)(this.configuration.url);
      }
      get channel() {
        const result = this.updater.channel || this.configuration.channel;
        return result == null ? this.getDefaultChannelName() : this.getCustomChannelName(result);
      }
      async getLatestVersion() {
        const channelFile = (0, util_1.getChannelFilename)(this.channel);
        const channelUrl = (0, util_1.newUrlFromBase)(channelFile, this.baseUrl, this.updater.isAddNoCacheQuery);
        for (let attemptNumber = 0; ; attemptNumber++) {
          try {
            return (0, Provider_12.parseUpdateInfo)(await this.httpRequest(channelUrl), channelFile, channelUrl);
          } catch (e) {
            if (e instanceof builder_util_runtime_1.HttpError && e.statusCode === 404) {
              throw (0, builder_util_runtime_1.newError)(`Cannot find channel "${channelFile}" update info: ${e.stack || e.message}`, "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND");
            } else if (e.code === "ECONNREFUSED") {
              if (attemptNumber < 3) {
                await new Promise((resolve, reject) => {
                  try {
                    setTimeout(resolve, 1e3 * attemptNumber);
                  } catch (e2) {
                    reject(e2);
                  }
                });
                continue;
              }
            }
            throw e;
          }
        }
      }
      resolveFiles(updateInfo) {
        return (0, Provider_12.resolveFiles)(updateInfo, this.baseUrl);
      }
    };
    exports2.GenericProvider = GenericProvider;
  }
});

// node_modules/.pnpm/electron-updater@6.8.9/node_modules/electron-updater/out/providers/BitbucketProvider.js
var require_BitbucketProvider = __commonJS({
  "node_modules/.pnpm/electron-updater@6.8.9/node_modules/electron-updater/out/providers/BitbucketProvider.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.BitbucketProvider = void 0;
    var builder_util_runtime_1 = require_out();
    var util_1 = require_util();
    var Provider_12 = require_Provider();
    var BitbucketProvider = class extends Provider_12.Provider {
      constructor(configuration, updater, runtimeOptions) {
        super({
          ...runtimeOptions,
          isUseMultipleRangeRequest: false
        });
        this.configuration = configuration;
        this.updater = updater;
        const { owner, slug } = configuration;
        this.baseUrl = (0, util_1.newBaseUrl)(`https://api.bitbucket.org/2.0/repositories/${owner}/${slug}/downloads`);
      }
      get channel() {
        return this.updater.channel || this.configuration.channel || "latest";
      }
      async getLatestVersion() {
        const cancellationToken = new builder_util_runtime_1.CancellationToken();
        const channelFile = (0, util_1.getChannelFilename)(this.getCustomChannelName(this.channel));
        const channelUrl = (0, util_1.newUrlFromBase)(channelFile, this.baseUrl, this.updater.isAddNoCacheQuery);
        try {
          const updateInfo = await this.httpRequest(channelUrl, void 0, cancellationToken);
          return (0, Provider_12.parseUpdateInfo)(updateInfo, channelFile, channelUrl);
        } catch (e) {
          throw (0, builder_util_runtime_1.newError)(`Unable to find latest version on ${this.toString()}, please ensure release exists: ${e.stack || e.message}`, "ERR_UPDATER_LATEST_VERSION_NOT_FOUND");
        }
      }
      resolveFiles(updateInfo) {
        return (0, Provider_12.resolveFiles)(updateInfo, this.baseUrl);
      }
      toString() {
        const { owner, slug } = this.configuration;
        return `Bitbucket (owner: ${owner}, slug: ${slug}, channel: ${this.channel})`;
      }
    };
    exports2.BitbucketProvider = BitbucketProvider;
  }
});

// node_modules/.pnpm/electron-updater@6.8.9/node_modules/electron-updater/out/providers/GitHubProvider.js
var require_GitHubProvider = __commonJS({
  "node_modules/.pnpm/electron-updater@6.8.9/node_modules/electron-updater/out/providers/GitHubProvider.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.GitHubProvider = exports2.BaseGitHubProvider = void 0;
    exports2.computeReleaseNotes = computeReleaseNotes;
    var builder_util_runtime_1 = require_out();
    var semver = require_semver2();
    var url_1 = require("url");
    var util_1 = require_util();
    var Provider_12 = require_Provider();
    var hrefRegExp = /\/tag\/(v?[^/]+)$/;
    var BaseGitHubProvider = class extends Provider_12.Provider {
      constructor(options, defaultHost, runtimeOptions) {
        super({
          ...runtimeOptions,
          /* because GitHib uses S3 */
          isUseMultipleRangeRequest: false
        });
        this.options = options;
        this.baseUrl = (0, util_1.newBaseUrl)((0, builder_util_runtime_1.githubUrl)(options, defaultHost));
        const apiHost = defaultHost === "github.com" ? "api.github.com" : defaultHost;
        this.baseApiUrl = (0, util_1.newBaseUrl)((0, builder_util_runtime_1.githubUrl)(options, apiHost));
      }
      computeGithubBasePath(result) {
        const host = this.options.host;
        return host && !["github.com", "api.github.com"].includes(host) ? `/api/v3${result}` : result;
      }
    };
    exports2.BaseGitHubProvider = BaseGitHubProvider;
    var GitHubProvider = class extends BaseGitHubProvider {
      constructor(options, updater, runtimeOptions) {
        super(options, "github.com", runtimeOptions);
        this.options = options;
        this.updater = updater;
      }
      get channel() {
        const result = this.updater.channel || this.options.channel;
        return result == null ? this.getDefaultChannelName() : this.getCustomChannelName(result);
      }
      async getLatestVersion() {
        var _a, _b, _c, _d, _e;
        const cancellationToken = new builder_util_runtime_1.CancellationToken();
        const feedXml = await this.httpRequest((0, util_1.newUrlFromBase)(`${this.basePath}.atom`, this.baseUrl), {
          accept: "application/xml, application/atom+xml, text/xml, */*"
        }, cancellationToken);
        const feed = (0, builder_util_runtime_1.parseXml)(feedXml);
        let latestRelease = feed.element("entry", false, `No published versions on GitHub`);
        let tag = null;
        try {
          if (this.updater.allowPrerelease) {
            const currentChannel = ((_a = this.updater) === null || _a === void 0 ? void 0 : _a.channel) || ((_b = semver.prerelease(this.updater.currentVersion)) === null || _b === void 0 ? void 0 : _b[0]) || null;
            if (currentChannel === null) {
              tag = hrefRegExp.exec(latestRelease.element("link").attribute("href"))[1];
            } else {
              for (const element of feed.getElements("entry")) {
                const hrefElement = hrefRegExp.exec(element.element("link").attribute("href"));
                if (hrefElement === null) {
                  continue;
                }
                const hrefTag = hrefElement[1];
                if (!semver.valid(hrefTag)) {
                  continue;
                }
                const hrefChannel = ((_c = semver.prerelease(hrefTag)) === null || _c === void 0 ? void 0 : _c[0]) || null;
                const shouldFetchVersion = !currentChannel || ["alpha", "beta"].includes(currentChannel);
                const isCustomChannel = hrefChannel !== null && !["alpha", "beta"].includes(String(hrefChannel));
                const channelMismatch = currentChannel === "beta" && hrefChannel === "alpha";
                if (shouldFetchVersion && !isCustomChannel && !channelMismatch) {
                  tag = hrefTag;
                  latestRelease = element;
                  break;
                }
                const isNextPreRelease = hrefChannel && hrefChannel === currentChannel;
                if (isNextPreRelease) {
                  tag = hrefTag;
                  latestRelease = element;
                  break;
                }
              }
            }
          } else {
            tag = await this.getLatestTagName(cancellationToken);
            for (const element of feed.getElements("entry")) {
              const hrefMatch = hrefRegExp.exec(element.element("link").attribute("href"));
              if (hrefMatch == null) {
                continue;
              }
              if (hrefMatch[1] === tag) {
                latestRelease = element;
                break;
              }
            }
          }
        } catch (e) {
          throw (0, builder_util_runtime_1.newError)(`Cannot parse releases feed: ${e.stack || e.message},
XML:
${feedXml}`, "ERR_UPDATER_INVALID_RELEASE_FEED");
        }
        if (tag == null) {
          throw (0, builder_util_runtime_1.newError)(`No published versions on GitHub`, "ERR_UPDATER_NO_PUBLISHED_VERSIONS");
        }
        let rawData;
        let channelFile = "";
        let channelFileUrl = "";
        const fetchData = async (channelName) => {
          channelFile = (0, util_1.getChannelFilename)(channelName);
          channelFileUrl = (0, util_1.newUrlFromBase)(this.getBaseDownloadPath(String(tag), channelFile), this.baseUrl);
          const requestOptions = this.createRequestOptions(channelFileUrl);
          try {
            return await this.executor.request(requestOptions, cancellationToken);
          } catch (e) {
            if (e instanceof builder_util_runtime_1.HttpError && e.statusCode === 404) {
              throw (0, builder_util_runtime_1.newError)(`Cannot find ${channelFile} in the latest release artifacts (${channelFileUrl}): ${e.stack || e.message}`, "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND");
            }
            throw e;
          }
        };
        try {
          let channel = this.channel;
          if (this.updater.allowPrerelease && ((_d = semver.prerelease(tag)) === null || _d === void 0 ? void 0 : _d[0])) {
            channel = this.getCustomChannelName(String((_e = semver.prerelease(tag)) === null || _e === void 0 ? void 0 : _e[0]));
          }
          rawData = await fetchData(channel);
        } catch (e) {
          if (this.updater.allowPrerelease) {
            rawData = await fetchData(this.getDefaultChannelName());
          } else {
            throw e;
          }
        }
        const result = (0, Provider_12.parseUpdateInfo)(rawData, channelFile, channelFileUrl);
        if (result.releaseName == null) {
          result.releaseName = latestRelease.elementValueOrEmpty("title");
        }
        if (result.releaseNotes == null) {
          result.releaseNotes = computeReleaseNotes(this.updater.currentVersion, this.updater.fullChangelog, feed, latestRelease);
        }
        return {
          tag,
          ...result
        };
      }
      async getLatestTagName(cancellationToken) {
        const options = this.options;
        const url = options.host == null || options.host === "github.com" ? (0, util_1.newUrlFromBase)(`${this.basePath}/latest`, this.baseUrl) : new url_1.URL(`${this.computeGithubBasePath(`/repos/${options.owner}/${options.repo}/releases`)}/latest`, this.baseApiUrl);
        try {
          const rawData = await this.httpRequest(url, { Accept: "application/json" }, cancellationToken);
          if (rawData == null) {
            return null;
          }
          const releaseInfo = JSON.parse(rawData);
          return releaseInfo.tag_name;
        } catch (e) {
          throw (0, builder_util_runtime_1.newError)(`Unable to find latest version on GitHub (${url}), please ensure a production release exists: ${e.stack || e.message}`, "ERR_UPDATER_LATEST_VERSION_NOT_FOUND");
        }
      }
      get basePath() {
        return `/${this.options.owner}/${this.options.repo}/releases`;
      }
      resolveFiles(updateInfo) {
        return (0, Provider_12.resolveFiles)(updateInfo, this.baseUrl, (p) => this.getBaseDownloadPath(updateInfo.tag, p.replace(/ /g, "-")));
      }
      getBaseDownloadPath(tag, fileName) {
        return `${this.basePath}/download/${tag}/${fileName}`;
      }
    };
    exports2.GitHubProvider = GitHubProvider;
    function getNoteValue(parent) {
      const result = parent.elementValueOrEmpty("content");
      return result === "No content." ? "" : result;
    }
    function computeReleaseNotes(currentVersion, isFullChangelog, feed, latestRelease) {
      if (!isFullChangelog) {
        return getNoteValue(latestRelease);
      }
      const releaseVersionRegExp = /\/tag\/v?([^/]+)$/;
      let latestVersion = void 0;
      try {
        latestVersion = releaseVersionRegExp.exec(latestRelease.element("link").attribute("href"))[1];
        latestVersion = semver.valid(latestVersion) ? latestVersion : void 0;
      } catch {
      }
      if (latestVersion == null) {
        return null;
      }
      const releaseNotes = [];
      for (const release of feed.getElements("entry")) {
        let versionRelease;
        try {
          const match = releaseVersionRegExp.exec(release.element("link").attribute("href"));
          if (!match) {
            continue;
          }
          versionRelease = match[1];
        } catch {
          continue;
        }
        if (!semver.valid(versionRelease)) {
          continue;
        }
        const isGreaterThanCurrent = semver.gt(versionRelease, currentVersion.raw);
        const isLessOrEqualThanLatest = semver.lte(versionRelease, latestVersion);
        if (isGreaterThanCurrent && isLessOrEqualThanLatest) {
          releaseNotes.push({
            version: versionRelease,
            note: getNoteValue(release)
          });
        }
      }
      return releaseNotes.sort((a, b) => semver.rcompare(a.version, b.version));
    }
  }
});

// node_modules/.pnpm/electron-updater@6.8.9/node_modules/electron-updater/out/providers/GitLabProvider.js
var require_GitLabProvider = __commonJS({
  "node_modules/.pnpm/electron-updater@6.8.9/node_modules/electron-updater/out/providers/GitLabProvider.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.GitLabProvider = void 0;
    var builder_util_runtime_1 = require_out();
    var url_1 = require("url");
    var escapeRegExp = require_lodash2();
    var util_1 = require_util();
    var Provider_12 = require_Provider();
    var GitLabProvider = class extends Provider_12.Provider {
      /**
       * Normalizes filenames by replacing spaces and underscores with dashes.
       *
       * This is a workaround to handle filename formatting differences between tools:
       * - electron-builder formats filenames like "test file.txt" as "test-file.txt"
       * - GitLab may provide asset URLs using underscores, such as "test_file.txt"
       *
       * Because of this mismatch, we can't reliably extract the correct filename from
       * the asset path without normalization. This function ensures consistent matching
       * across different filename formats by converting all spaces and underscores to dashes.
       *
       * @param filename The filename to normalize
       * @returns The normalized filename with spaces and underscores replaced by dashes
       */
      normalizeFilename(filename) {
        return filename.replace(/ |_/g, "-");
      }
      constructor(options, updater, runtimeOptions) {
        super({
          ...runtimeOptions,
          // GitLab might not support multiple range requests efficiently
          isUseMultipleRangeRequest: false
        });
        this.options = options;
        this.updater = updater;
        this.cachedLatestVersion = null;
        const defaultHost = "gitlab.com";
        const host = options.host || defaultHost;
        this.baseApiUrl = (0, util_1.newBaseUrl)(`https://${host}/api/v4`);
      }
      createRequestOptions(url, headers) {
        const result = super.createRequestOptions(url, headers);
        result.redirect = "manual";
        return result;
      }
      get channel() {
        const result = this.updater.channel || this.options.channel;
        return result == null ? this.getDefaultChannelName() : this.getCustomChannelName(result);
      }
      async getLatestVersion() {
        const cancellationToken = new builder_util_runtime_1.CancellationToken();
        const latestReleaseUrl = (0, util_1.newUrlFromBase)(`projects/${this.options.projectId}/releases/permalink/latest`, this.baseApiUrl);
        const header = { Accept: "application/json", ...this.setAuthHeaderForToken(this.options.token || null) };
        let releaseResponse;
        try {
          releaseResponse = await this.httpRequest(latestReleaseUrl, header, cancellationToken);
        } catch (e) {
          throw (0, builder_util_runtime_1.newError)(`Unable to find latest release on GitLab (${latestReleaseUrl}): ${e.stack || e.message}`, "ERR_UPDATER_LATEST_VERSION_NOT_FOUND");
        }
        if (!releaseResponse) {
          throw (0, builder_util_runtime_1.newError)("No published releases on GitLab", "ERR_UPDATER_NO_PUBLISHED_VERSIONS");
        }
        let latestRelease;
        try {
          latestRelease = JSON.parse(releaseResponse);
        } catch (e) {
          throw (0, builder_util_runtime_1.newError)(`Unable to parse latest release response from GitLab (${latestReleaseUrl}): response was not valid JSON: ${e.stack || e.message}`, "ERR_UPDATER_LATEST_VERSION_NOT_FOUND");
        }
        if (latestRelease.upcoming_release) {
          throw (0, builder_util_runtime_1.newError)("Latest GitLab release is scheduled but not yet published", "ERR_UPDATER_LATEST_VERSION_NOT_FOUND");
        }
        const tag = latestRelease.tag_name;
        let rawData = null;
        let channelFile = "";
        let channelFileUrl = null;
        const fetchChannelData = async (channelName) => {
          channelFile = (0, util_1.getChannelFilename)(channelName);
          const channelAsset = latestRelease.assets.links.find((asset) => asset.name === channelFile);
          if (!channelAsset) {
            throw (0, builder_util_runtime_1.newError)(`Cannot find ${channelFile} in the latest release assets`, "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND");
          }
          channelFileUrl = new url_1.URL(channelAsset.direct_asset_url);
          const authHeaders = this.setAuthHeaderForToken(this.options.token || null);
          const headers = Object.keys(authHeaders).length ? authHeaders : void 0;
          try {
            const result2 = await this.httpRequest(channelFileUrl, headers, cancellationToken);
            if (!result2) {
              throw (0, builder_util_runtime_1.newError)(`Empty response from ${channelFileUrl}`, "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND");
            }
            return result2;
          } catch (e) {
            if (e instanceof builder_util_runtime_1.HttpError && e.statusCode === 404) {
              throw (0, builder_util_runtime_1.newError)(`Cannot find ${channelFile} in the latest release artifacts (${channelFileUrl}): ${e.stack || e.message}`, "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND");
            }
            throw e;
          }
        };
        try {
          rawData = await fetchChannelData(this.channel);
        } catch (e) {
          if (this.channel !== this.getDefaultChannelName()) {
            rawData = await fetchChannelData(this.getDefaultChannelName());
          } else {
            throw e;
          }
        }
        if (!rawData) {
          throw (0, builder_util_runtime_1.newError)(`Unable to parse channel data from ${channelFile}`, "ERR_UPDATER_INVALID_UPDATE_INFO");
        }
        const result = (0, Provider_12.parseUpdateInfo)(rawData, channelFile, channelFileUrl);
        if (result.releaseName == null) {
          result.releaseName = latestRelease.name;
        }
        if (result.releaseNotes == null) {
          result.releaseNotes = latestRelease.description || null;
        }
        const gitlabUpdateInfo = {
          tag,
          assets: this.convertAssetsToMap(latestRelease.assets),
          ...result
        };
        this.cachedLatestVersion = gitlabUpdateInfo;
        return gitlabUpdateInfo;
      }
      /**
       * Utility function to convert GitlabReleaseAsset to Map<string, string>
       * Maps asset names to their download URLs
       */
      convertAssetsToMap(assets) {
        const assetsMap = /* @__PURE__ */ new Map();
        for (const asset of assets.links) {
          assetsMap.set(this.normalizeFilename(asset.name), asset.direct_asset_url);
        }
        return assetsMap;
      }
      /**
       * Find blockmap file URL in assets map for a specific filename
       */
      findBlockMapInAssets(assets, filename) {
        const possibleBlockMapNames = [`${filename}.blockmap`, `${this.normalizeFilename(filename)}.blockmap`];
        for (const blockMapName of possibleBlockMapNames) {
          const assetUrl = assets.get(blockMapName);
          if (assetUrl) {
            return new url_1.URL(assetUrl);
          }
        }
        return null;
      }
      async fetchReleaseInfoByVersion(version) {
        const cancellationToken = new builder_util_runtime_1.CancellationToken();
        const possibleReleaseIds = [`v${version}`, version];
        for (const releaseId of possibleReleaseIds) {
          const releaseUrl = (0, util_1.newUrlFromBase)(`projects/${this.options.projectId}/releases/${encodeURIComponent(releaseId)}`, this.baseApiUrl);
          try {
            const header = { Accept: "application/json", ...this.setAuthHeaderForToken(this.options.token || null) };
            const releaseResponse = await this.httpRequest(releaseUrl, header, cancellationToken);
            if (releaseResponse) {
              const release = JSON.parse(releaseResponse);
              return release;
            }
          } catch (e) {
            if (e instanceof builder_util_runtime_1.HttpError && e.statusCode === 404) {
              continue;
            }
            throw (0, builder_util_runtime_1.newError)(`Unable to find release ${releaseId} on GitLab (${releaseUrl}): ${e.stack || e.message}`, "ERR_UPDATER_RELEASE_NOT_FOUND");
          }
        }
        throw (0, builder_util_runtime_1.newError)(`Unable to find release with version ${version} (tried: ${possibleReleaseIds.join(", ")}) on GitLab`, "ERR_UPDATER_RELEASE_NOT_FOUND");
      }
      setAuthHeaderForToken(token) {
        const headers = {};
        if (token != null) {
          if (token.startsWith("Bearer")) {
            headers.authorization = token;
          } else {
            headers["PRIVATE-TOKEN"] = token;
          }
        }
        return headers;
      }
      /**
       * Get version info for blockmap files, using cache when possible
       */
      async getVersionInfoForBlockMap(version) {
        if (this.cachedLatestVersion && this.cachedLatestVersion.version === version) {
          return this.cachedLatestVersion.assets;
        }
        const versionInfo = await this.fetchReleaseInfoByVersion(version);
        if (versionInfo && versionInfo.assets) {
          return this.convertAssetsToMap(versionInfo.assets);
        }
        return null;
      }
      /**
       * Find blockmap URLs from version assets
       */
      async findBlockMapUrlsFromAssets(oldVersion, newVersion, baseFilename) {
        let newBlockMapUrl = null;
        let oldBlockMapUrl = null;
        const newVersionAssets = await this.getVersionInfoForBlockMap(newVersion);
        if (newVersionAssets) {
          newBlockMapUrl = this.findBlockMapInAssets(newVersionAssets, baseFilename);
        }
        const oldVersionAssets = await this.getVersionInfoForBlockMap(oldVersion);
        if (oldVersionAssets) {
          const oldFilename = baseFilename.replace(new RegExp(escapeRegExp(newVersion), "g"), oldVersion);
          oldBlockMapUrl = this.findBlockMapInAssets(oldVersionAssets, oldFilename);
        }
        return [oldBlockMapUrl, newBlockMapUrl];
      }
      async getBlockMapFiles(baseUrl, oldVersion, newVersion, oldBlockMapFileBaseUrl = null) {
        if (this.options.uploadTarget === "project_upload") {
          const baseFilename = baseUrl.pathname.split("/").pop() || "";
          const [oldBlockMapUrl, newBlockMapUrl] = await this.findBlockMapUrlsFromAssets(oldVersion, newVersion, baseFilename);
          if (!newBlockMapUrl) {
            throw (0, builder_util_runtime_1.newError)(`Cannot find blockmap file for ${newVersion} in GitLab assets`, "ERR_UPDATER_BLOCKMAP_FILE_NOT_FOUND");
          }
          if (!oldBlockMapUrl) {
            throw (0, builder_util_runtime_1.newError)(`Cannot find blockmap file for ${oldVersion} in GitLab assets`, "ERR_UPDATER_BLOCKMAP_FILE_NOT_FOUND");
          }
          return [oldBlockMapUrl, newBlockMapUrl];
        } else {
          return super.getBlockMapFiles(baseUrl, oldVersion, newVersion, oldBlockMapFileBaseUrl);
        }
      }
      resolveFiles(updateInfo) {
        return (0, Provider_12.getFileList)(updateInfo).map((fileInfo) => {
          const possibleNames = [
            fileInfo.url,
            // Original filename
            this.normalizeFilename(fileInfo.url)
            // Normalized filename (spaces/underscores → dashes)
          ];
          const matchingAssetName = possibleNames.find((name) => updateInfo.assets.has(name));
          const assetUrl = matchingAssetName ? updateInfo.assets.get(matchingAssetName) : void 0;
          if (!assetUrl) {
            throw (0, builder_util_runtime_1.newError)(`Cannot find asset "${fileInfo.url}" in GitLab release assets. Available assets: ${Array.from(updateInfo.assets.keys()).join(", ")}`, "ERR_UPDATER_ASSET_NOT_FOUND");
          }
          return {
            url: new url_1.URL(assetUrl),
            info: fileInfo
          };
        });
      }
      toString() {
        return `GitLab (projectId: ${this.options.projectId}, channel: ${this.channel})`;
      }
    };
    exports2.GitLabProvider = GitLabProvider;
  }
});

// node_modules/.pnpm/electron-updater@6.8.9/node_modules/electron-updater/out/providers/KeygenProvider.js
var require_KeygenProvider = __commonJS({
  "node_modules/.pnpm/electron-updater@6.8.9/node_modules/electron-updater/out/providers/KeygenProvider.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.KeygenProvider = void 0;
    var builder_util_runtime_1 = require_out();
    var util_1 = require_util();
    var Provider_12 = require_Provider();
    var KeygenProvider = class extends Provider_12.Provider {
      constructor(configuration, updater, runtimeOptions) {
        super({
          ...runtimeOptions,
          isUseMultipleRangeRequest: false
        });
        this.configuration = configuration;
        this.updater = updater;
        this.defaultHostname = "api.keygen.sh";
        const host = this.configuration.host || this.defaultHostname;
        this.baseUrl = (0, util_1.newBaseUrl)(`https://${host}/v1/accounts/${this.configuration.account}/artifacts?product=${this.configuration.product}`);
      }
      get channel() {
        return this.updater.channel || this.configuration.channel || "stable";
      }
      async getLatestVersion() {
        const cancellationToken = new builder_util_runtime_1.CancellationToken();
        const channelFile = (0, util_1.getChannelFilename)(this.getCustomChannelName(this.channel));
        const channelUrl = (0, util_1.newUrlFromBase)(channelFile, this.baseUrl, this.updater.isAddNoCacheQuery);
        try {
          const updateInfo = await this.httpRequest(channelUrl, {
            Accept: "application/vnd.api+json",
            "Keygen-Version": "1.1"
          }, cancellationToken);
          return (0, Provider_12.parseUpdateInfo)(updateInfo, channelFile, channelUrl);
        } catch (e) {
          throw (0, builder_util_runtime_1.newError)(`Unable to find latest version on ${this.toString()}, please ensure release exists: ${e.stack || e.message}`, "ERR_UPDATER_LATEST_VERSION_NOT_FOUND");
        }
      }
      resolveFiles(updateInfo) {
        return (0, Provider_12.resolveFiles)(updateInfo, this.baseUrl);
      }
      toString() {
        const { account, product, platform } = this.configuration;
        return `Keygen (account: ${account}, product: ${product}, platform: ${platform}, channel: ${this.channel})`;
      }
    };
    exports2.KeygenProvider = KeygenProvider;
  }
});

// node_modules/.pnpm/electron-updater@6.8.9/node_modules/electron-updater/out/providers/PrivateGitHubProvider.js
var require_PrivateGitHubProvider = __commonJS({
  "node_modules/.pnpm/electron-updater@6.8.9/node_modules/electron-updater/out/providers/PrivateGitHubProvider.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.PrivateGitHubProvider = void 0;
    var builder_util_runtime_1 = require_out();
    var js_yaml_1 = require_js_yaml_cjs();
    var path2 = require("path");
    var url_1 = require("url");
    var util_1 = require_util();
    var GitHubProvider_1 = require_GitHubProvider();
    var Provider_12 = require_Provider();
    var PrivateGitHubProvider = class extends GitHubProvider_1.BaseGitHubProvider {
      constructor(options, updater, token, runtimeOptions) {
        super(options, "api.github.com", runtimeOptions);
        this.updater = updater;
        this.token = token;
      }
      createRequestOptions(url, headers) {
        const result = super.createRequestOptions(url, headers);
        result.redirect = "manual";
        return result;
      }
      async getLatestVersion() {
        const cancellationToken = new builder_util_runtime_1.CancellationToken();
        const channelFile = (0, util_1.getChannelFilename)(this.getDefaultChannelName());
        const releaseInfo = await this.getLatestVersionInfo(cancellationToken);
        const asset = releaseInfo.assets.find((it) => it.name === channelFile);
        if (asset == null) {
          throw (0, builder_util_runtime_1.newError)(`Cannot find ${channelFile} in the release ${releaseInfo.html_url || releaseInfo.name}`, "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND");
        }
        const url = new url_1.URL(asset.url);
        let result;
        try {
          result = (0, js_yaml_1.load)(await this.httpRequest(url, this.configureHeaders("application/octet-stream"), cancellationToken));
        } catch (e) {
          if (e instanceof builder_util_runtime_1.HttpError && e.statusCode === 404) {
            throw (0, builder_util_runtime_1.newError)(`Cannot find ${channelFile} in the latest release artifacts (${url}): ${e.stack || e.message}`, "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND");
          }
          throw e;
        }
        ;
        result.assets = releaseInfo.assets;
        return result;
      }
      get fileExtraDownloadHeaders() {
        return this.configureHeaders("application/octet-stream");
      }
      configureHeaders(accept) {
        return {
          accept,
          authorization: `token ${this.token}`
        };
      }
      async getLatestVersionInfo(cancellationToken) {
        const allowPrerelease = this.updater.allowPrerelease;
        let basePath = this.basePath;
        if (!allowPrerelease) {
          basePath = `${basePath}/latest`;
        }
        const url = (0, util_1.newUrlFromBase)(basePath, this.baseUrl);
        try {
          const version = JSON.parse(await this.httpRequest(url, this.configureHeaders("application/vnd.github.v3+json"), cancellationToken));
          if (allowPrerelease) {
            const candidates = version.filter((it) => !it.draft);
            return candidates.find((it) => it.prerelease) || candidates[0];
          } else {
            return version;
          }
        } catch (e) {
          throw (0, builder_util_runtime_1.newError)(`Unable to find latest version on GitHub (${url}), please ensure a production release exists: ${e.stack || e.message}`, "ERR_UPDATER_LATEST_VERSION_NOT_FOUND");
        }
      }
      get basePath() {
        return this.computeGithubBasePath(`/repos/${this.options.owner}/${this.options.repo}/releases`);
      }
      resolveFiles(updateInfo) {
        return (0, Provider_12.getFileList)(updateInfo).map((it) => {
          const name = path2.posix.basename(it.url).replace(/ /g, "-");
          const asset = updateInfo.assets.find((it2) => it2 != null && it2.name === name);
          if (asset == null) {
            throw (0, builder_util_runtime_1.newError)(`Cannot find asset "${name}" in: ${JSON.stringify(updateInfo.assets, null, 2)}`, "ERR_UPDATER_ASSET_NOT_FOUND");
          }
          return {
            url: new url_1.URL(asset.url),
            info: it
          };
        });
      }
    };
    exports2.PrivateGitHubProvider = PrivateGitHubProvider;
  }
});

// node_modules/.pnpm/electron-updater@6.8.9/node_modules/electron-updater/out/providerFactory.js
var require_providerFactory = __commonJS({
  "node_modules/.pnpm/electron-updater@6.8.9/node_modules/electron-updater/out/providerFactory.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.isUrlProbablySupportMultiRangeRequests = isUrlProbablySupportMultiRangeRequests;
    exports2.createClient = createClient;
    var builder_util_runtime_1 = require_out();
    var BitbucketProvider_1 = require_BitbucketProvider();
    var GenericProvider_1 = require_GenericProvider();
    var GitHubProvider_1 = require_GitHubProvider();
    var GitLabProvider_1 = require_GitLabProvider();
    var KeygenProvider_1 = require_KeygenProvider();
    var PrivateGitHubProvider_1 = require_PrivateGitHubProvider();
    function isUrlProbablySupportMultiRangeRequests(url) {
      return !url.includes("s3.amazonaws.com");
    }
    function createClient(data, updater, runtimeOptions) {
      if (typeof data === "string") {
        throw (0, builder_util_runtime_1.newError)("Please pass PublishConfiguration object", "ERR_UPDATER_INVALID_PROVIDER_CONFIGURATION");
      }
      const provider = data.provider;
      switch (provider) {
        case "github": {
          const githubOptions = data;
          const token = (githubOptions.private ? process.env["GH_TOKEN"] || process.env["GITHUB_TOKEN"] : null) || githubOptions.token;
          if (token == null) {
            return new GitHubProvider_1.GitHubProvider(githubOptions, updater, runtimeOptions);
          } else {
            return new PrivateGitHubProvider_1.PrivateGitHubProvider(githubOptions, updater, token, runtimeOptions);
          }
        }
        case "bitbucket":
          return new BitbucketProvider_1.BitbucketProvider(data, updater, runtimeOptions);
        case "gitlab":
          return new GitLabProvider_1.GitLabProvider(data, updater, runtimeOptions);
        case "keygen":
          return new KeygenProvider_1.KeygenProvider(data, updater, runtimeOptions);
        case "s3":
        case "spaces":
          return new GenericProvider_1.GenericProvider({
            provider: "generic",
            url: (0, builder_util_runtime_1.getS3LikeProviderBaseUrl)(data),
            channel: data.channel || null
          }, updater, {
            ...runtimeOptions,
            // https://github.com/minio/minio/issues/5285#issuecomment-350428955
            isUseMultipleRangeRequest: false
          });
        case "generic": {
          const options = data;
          return new GenericProvider_1.GenericProvider(options, updater, {
            ...runtimeOptions,
            isUseMultipleRangeRequest: options.useMultipleRangeRequest !== false && isUrlProbablySupportMultiRangeRequests(options.url)
          });
        }
        case "custom": {
          const options = data;
          const constructor = options.updateProvider;
          if (!constructor) {
            throw (0, builder_util_runtime_1.newError)("Custom provider not specified", "ERR_UPDATER_INVALID_PROVIDER_CONFIGURATION");
          }
          return new constructor(options, updater, runtimeOptions);
        }
        default:
          throw (0, builder_util_runtime_1.newError)(`Unsupported provider: ${provider}`, "ERR_UPDATER_UNSUPPORTED_PROVIDER");
      }
    }
  }
});

// node_modules/.pnpm/electron-updater@6.8.9/node_modules/electron-updater/out/differentialDownloader/downloadPlanBuilder.js
var require_downloadPlanBuilder = __commonJS({
  "node_modules/.pnpm/electron-updater@6.8.9/node_modules/electron-updater/out/differentialDownloader/downloadPlanBuilder.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.OperationKind = void 0;
    exports2.computeOperations = computeOperations;
    var OperationKind;
    (function(OperationKind2) {
      OperationKind2[OperationKind2["COPY"] = 0] = "COPY";
      OperationKind2[OperationKind2["DOWNLOAD"] = 1] = "DOWNLOAD";
    })(OperationKind || (exports2.OperationKind = OperationKind = {}));
    function computeOperations(oldBlockMap, newBlockMap, logger) {
      const nameToOldBlocks = buildBlockFileMap(oldBlockMap.files);
      const nameToNewBlocks = buildBlockFileMap(newBlockMap.files);
      let lastOperation = null;
      const blockMapFile = newBlockMap.files[0];
      const operations = [];
      const name = blockMapFile.name;
      const oldEntry = nameToOldBlocks.get(name);
      if (oldEntry == null) {
        throw new Error(`no file ${name} in old blockmap`);
      }
      const newFile = nameToNewBlocks.get(name);
      let changedBlockCount = 0;
      const { checksumToOffset: checksumToOldOffset, checksumToOldSize } = buildChecksumMap(nameToOldBlocks.get(name), oldEntry.offset, logger);
      let newOffset = blockMapFile.offset;
      for (let i = 0; i < newFile.checksums.length; newOffset += newFile.sizes[i], i++) {
        const blockSize = newFile.sizes[i];
        const checksum = newFile.checksums[i];
        let oldOffset = checksumToOldOffset.get(checksum);
        if (oldOffset != null && checksumToOldSize.get(checksum) !== blockSize) {
          logger.warn(`Checksum ("${checksum}") matches, but size differs (old: ${checksumToOldSize.get(checksum)}, new: ${blockSize})`);
          oldOffset = void 0;
        }
        if (oldOffset === void 0) {
          changedBlockCount++;
          if (lastOperation != null && lastOperation.kind === OperationKind.DOWNLOAD && lastOperation.end === newOffset) {
            lastOperation.end += blockSize;
          } else {
            lastOperation = {
              kind: OperationKind.DOWNLOAD,
              start: newOffset,
              end: newOffset + blockSize
              // oldBlocks: null,
            };
            validateAndAdd(lastOperation, operations, checksum, i);
          }
        } else {
          if (lastOperation != null && lastOperation.kind === OperationKind.COPY && lastOperation.end === oldOffset) {
            lastOperation.end += blockSize;
          } else {
            lastOperation = {
              kind: OperationKind.COPY,
              start: oldOffset,
              end: oldOffset + blockSize
              // oldBlocks: [checksum]
            };
            validateAndAdd(lastOperation, operations, checksum, i);
          }
        }
      }
      if (changedBlockCount > 0) {
        logger.info(`File${blockMapFile.name === "file" ? "" : " " + blockMapFile.name} has ${changedBlockCount} changed blocks`);
      }
      return operations;
    }
    var isValidateOperationRange = process.env["DIFFERENTIAL_DOWNLOAD_PLAN_BUILDER_VALIDATE_RANGES"] === "true";
    function validateAndAdd(operation, operations, checksum, index) {
      if (isValidateOperationRange && operations.length !== 0) {
        const lastOperation = operations[operations.length - 1];
        if (lastOperation.kind === operation.kind && operation.start < lastOperation.end && operation.start > lastOperation.start) {
          const min = [lastOperation.start, lastOperation.end, operation.start, operation.end].reduce((p, v) => p < v ? p : v);
          throw new Error(`operation (block index: ${index}, checksum: ${checksum}, kind: ${OperationKind[operation.kind]}) overlaps previous operation (checksum: ${checksum}):
abs: ${lastOperation.start} until ${lastOperation.end} and ${operation.start} until ${operation.end}
rel: ${lastOperation.start - min} until ${lastOperation.end - min} and ${operation.start - min} until ${operation.end - min}`);
        }
      }
      operations.push(operation);
    }
    function buildChecksumMap(file, fileOffset, logger) {
      const checksumToOffset = /* @__PURE__ */ new Map();
      const checksumToSize = /* @__PURE__ */ new Map();
      let offset = fileOffset;
      for (let i = 0; i < file.checksums.length; i++) {
        const checksum = file.checksums[i];
        const size = file.sizes[i];
        const existing = checksumToSize.get(checksum);
        if (existing === void 0) {
          checksumToOffset.set(checksum, offset);
          checksumToSize.set(checksum, size);
        } else if (logger.debug != null) {
          const sizeExplanation = existing === size ? "(same size)" : `(size: ${existing}, this size: ${size})`;
          logger.debug(`${checksum} duplicated in blockmap ${sizeExplanation}, it doesn't lead to broken differential downloader, just corresponding block will be skipped)`);
        }
        offset += size;
      }
      return { checksumToOffset, checksumToOldSize: checksumToSize };
    }
    function buildBlockFileMap(list) {
      const result = /* @__PURE__ */ new Map();
      for (const item of list) {
        result.set(item.name, item);
      }
      return result;
    }
  }
});

// node_modules/.pnpm/electron-updater@6.8.9/node_modules/electron-updater/out/differentialDownloader/DataSplitter.js
var require_DataSplitter = __commonJS({
  "node_modules/.pnpm/electron-updater@6.8.9/node_modules/electron-updater/out/differentialDownloader/DataSplitter.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.DataSplitter = void 0;
    exports2.copyData = copyData;
    var builder_util_runtime_1 = require_out();
    var fs_1 = require("fs");
    var stream_1 = require("stream");
    var downloadPlanBuilder_1 = require_downloadPlanBuilder();
    var DOUBLE_CRLF = Buffer.from("\r\n\r\n");
    var ReadState;
    (function(ReadState2) {
      ReadState2[ReadState2["INIT"] = 0] = "INIT";
      ReadState2[ReadState2["HEADER"] = 1] = "HEADER";
      ReadState2[ReadState2["BODY"] = 2] = "BODY";
    })(ReadState || (ReadState = {}));
    function copyData(task, out, oldFileFd, reject, resolve) {
      const readStream = (0, fs_1.createReadStream)("", {
        fd: oldFileFd,
        autoClose: false,
        start: task.start,
        // end is inclusive
        end: task.end - 1
      });
      readStream.on("error", reject);
      readStream.once("end", resolve);
      readStream.pipe(out, {
        end: false
      });
    }
    var DataSplitter = class extends stream_1.Writable {
      constructor(out, options, partIndexToTaskIndex, boundary, partIndexToLength, finishHandler, grandTotalBytes, onProgress) {
        super();
        this.out = out;
        this.options = options;
        this.partIndexToTaskIndex = partIndexToTaskIndex;
        this.partIndexToLength = partIndexToLength;
        this.finishHandler = finishHandler;
        this.grandTotalBytes = grandTotalBytes;
        this.onProgress = onProgress;
        this.start = Date.now();
        this.nextUpdate = this.start + 1e3;
        this.transferred = 0;
        this.delta = 0;
        this.partIndex = -1;
        this.headerListBuffer = null;
        this.readState = ReadState.INIT;
        this.ignoreByteCount = 0;
        this.remainingPartDataCount = 0;
        this.actualPartLength = 0;
        this.boundaryLength = boundary.length + 4;
        this.ignoreByteCount = this.boundaryLength - 2;
      }
      get isFinished() {
        return this.partIndex === this.partIndexToLength.length;
      }
      // noinspection JSUnusedGlobalSymbols
      _write(data, encoding, callback) {
        if (this.isFinished) {
          console.error(`Trailing ignored data: ${data.length} bytes`);
          return;
        }
        this.handleData(data).then(() => {
          if (this.onProgress) {
            const now = Date.now();
            if ((now >= this.nextUpdate || this.transferred === this.grandTotalBytes) && this.grandTotalBytes && (now - this.start) / 1e3) {
              this.nextUpdate = now + 1e3;
              this.onProgress({
                total: this.grandTotalBytes,
                delta: this.delta,
                transferred: this.transferred,
                percent: this.transferred / this.grandTotalBytes * 100,
                bytesPerSecond: Math.round(this.transferred / ((now - this.start) / 1e3))
              });
              this.delta = 0;
            }
          }
          callback();
        }).catch(callback);
      }
      async handleData(chunk) {
        let start = 0;
        if (this.ignoreByteCount !== 0 && this.remainingPartDataCount !== 0) {
          throw (0, builder_util_runtime_1.newError)("Internal error", "ERR_DATA_SPLITTER_BYTE_COUNT_MISMATCH");
        }
        if (this.ignoreByteCount > 0) {
          const toIgnore = Math.min(this.ignoreByteCount, chunk.length);
          this.ignoreByteCount -= toIgnore;
          start = toIgnore;
        } else if (this.remainingPartDataCount > 0) {
          const toRead = Math.min(this.remainingPartDataCount, chunk.length);
          this.remainingPartDataCount -= toRead;
          await this.processPartData(chunk, 0, toRead);
          start = toRead;
        }
        if (start === chunk.length) {
          return;
        }
        if (this.readState === ReadState.HEADER) {
          const headerListEnd = this.searchHeaderListEnd(chunk, start);
          if (headerListEnd === -1) {
            return;
          }
          start = headerListEnd;
          this.readState = ReadState.BODY;
          this.headerListBuffer = null;
        }
        while (true) {
          if (this.readState === ReadState.BODY) {
            this.readState = ReadState.INIT;
          } else {
            this.partIndex++;
            let taskIndex = this.partIndexToTaskIndex.get(this.partIndex);
            if (taskIndex == null) {
              if (this.isFinished) {
                taskIndex = this.options.end;
              } else {
                throw (0, builder_util_runtime_1.newError)("taskIndex is null", "ERR_DATA_SPLITTER_TASK_INDEX_IS_NULL");
              }
            }
            const prevTaskIndex = this.partIndex === 0 ? this.options.start : this.partIndexToTaskIndex.get(this.partIndex - 1) + 1;
            if (prevTaskIndex < taskIndex) {
              await this.copyExistingData(prevTaskIndex, taskIndex);
            } else if (prevTaskIndex > taskIndex) {
              throw (0, builder_util_runtime_1.newError)("prevTaskIndex must be < taskIndex", "ERR_DATA_SPLITTER_TASK_INDEX_ASSERT_FAILED");
            }
            if (this.isFinished) {
              this.onPartEnd();
              this.finishHandler();
              return;
            }
            start = this.searchHeaderListEnd(chunk, start);
            if (start === -1) {
              this.readState = ReadState.HEADER;
              return;
            }
          }
          const partLength = this.partIndexToLength[this.partIndex];
          const end = start + partLength;
          const effectiveEnd = Math.min(end, chunk.length);
          await this.processPartStarted(chunk, start, effectiveEnd);
          this.remainingPartDataCount = partLength - (effectiveEnd - start);
          if (this.remainingPartDataCount > 0) {
            return;
          }
          start = end + this.boundaryLength;
          if (start >= chunk.length) {
            this.ignoreByteCount = this.boundaryLength - (chunk.length - end);
            return;
          }
        }
      }
      copyExistingData(index, end) {
        return new Promise((resolve, reject) => {
          const w = () => {
            if (index === end) {
              resolve();
              return;
            }
            const task = this.options.tasks[index];
            if (task.kind !== downloadPlanBuilder_1.OperationKind.COPY) {
              reject(new Error("Task kind must be COPY"));
              return;
            }
            copyData(task, this.out, this.options.oldFileFd, reject, () => {
              index++;
              w();
            });
          };
          w();
        });
      }
      searchHeaderListEnd(chunk, readOffset) {
        const headerListEnd = chunk.indexOf(DOUBLE_CRLF, readOffset);
        if (headerListEnd !== -1) {
          return headerListEnd + DOUBLE_CRLF.length;
        }
        const partialChunk = readOffset === 0 ? chunk : chunk.slice(readOffset);
        if (this.headerListBuffer == null) {
          this.headerListBuffer = partialChunk;
        } else {
          this.headerListBuffer = Buffer.concat([this.headerListBuffer, partialChunk]);
        }
        return -1;
      }
      onPartEnd() {
        const expectedLength = this.partIndexToLength[this.partIndex - 1];
        if (this.actualPartLength !== expectedLength) {
          throw (0, builder_util_runtime_1.newError)(`Expected length: ${expectedLength} differs from actual: ${this.actualPartLength}`, "ERR_DATA_SPLITTER_LENGTH_MISMATCH");
        }
        this.actualPartLength = 0;
      }
      processPartStarted(data, start, end) {
        if (this.partIndex !== 0) {
          this.onPartEnd();
        }
        return this.processPartData(data, start, end);
      }
      processPartData(data, start, end) {
        this.actualPartLength += end - start;
        this.transferred += end - start;
        this.delta += end - start;
        const out = this.out;
        if (out.write(start === 0 && data.length === end ? data : data.slice(start, end))) {
          return Promise.resolve();
        } else {
          return new Promise((resolve, reject) => {
            out.on("error", reject);
            out.once("drain", () => {
              out.removeListener("error", reject);
              resolve();
            });
          });
        }
      }
    };
    exports2.DataSplitter = DataSplitter;
  }
});

// node_modules/.pnpm/electron-updater@6.8.9/node_modules/electron-updater/out/differentialDownloader/multipleRangeDownloader.js
var require_multipleRangeDownloader = __commonJS({
  "node_modules/.pnpm/electron-updater@6.8.9/node_modules/electron-updater/out/differentialDownloader/multipleRangeDownloader.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.executeTasksUsingMultipleRangeRequests = executeTasksUsingMultipleRangeRequests;
    exports2.checkIsRangesSupported = checkIsRangesSupported;
    var builder_util_runtime_1 = require_out();
    var DataSplitter_1 = require_DataSplitter();
    var downloadPlanBuilder_1 = require_downloadPlanBuilder();
    function executeTasksUsingMultipleRangeRequests(differentialDownloader, tasks, out, oldFileFd, reject) {
      const w = (taskOffset) => {
        if (taskOffset >= tasks.length) {
          if (differentialDownloader.fileMetadataBuffer != null) {
            out.write(differentialDownloader.fileMetadataBuffer);
          }
          out.end();
          return;
        }
        const nextOffset = taskOffset + 1e3;
        doExecuteTasks(differentialDownloader, {
          tasks,
          start: taskOffset,
          end: Math.min(tasks.length, nextOffset),
          oldFileFd
        }, out, () => w(nextOffset), reject);
      };
      return w;
    }
    function doExecuteTasks(differentialDownloader, options, out, resolve, reject) {
      let ranges = "bytes=";
      let partCount = 0;
      let grandTotalBytes = 0;
      const partIndexToTaskIndex = /* @__PURE__ */ new Map();
      const partIndexToLength = [];
      for (let i = options.start; i < options.end; i++) {
        const task = options.tasks[i];
        if (task.kind === downloadPlanBuilder_1.OperationKind.DOWNLOAD) {
          ranges += `${task.start}-${task.end - 1}, `;
          partIndexToTaskIndex.set(partCount, i);
          partCount++;
          partIndexToLength.push(task.end - task.start);
          grandTotalBytes += task.end - task.start;
        }
      }
      if (partCount <= 1) {
        const w = (index) => {
          if (index >= options.end) {
            resolve();
            return;
          }
          const task = options.tasks[index++];
          if (task.kind === downloadPlanBuilder_1.OperationKind.COPY) {
            (0, DataSplitter_1.copyData)(task, out, options.oldFileFd, reject, () => w(index));
          } else {
            const requestOptions2 = differentialDownloader.createRequestOptions();
            requestOptions2.headers.Range = `bytes=${task.start}-${task.end - 1}`;
            const request2 = differentialDownloader.httpExecutor.createRequest(requestOptions2, (response) => {
              response.on("error", reject);
              if (!checkIsRangesSupported(response, reject)) {
                return;
              }
              response.pipe(out, {
                end: false
              });
              response.once("end", () => w(index));
            });
            differentialDownloader.httpExecutor.addErrorAndTimeoutHandlers(request2, reject);
            request2.end();
          }
        };
        w(options.start);
        return;
      }
      const requestOptions = differentialDownloader.createRequestOptions();
      requestOptions.headers.Range = ranges.substring(0, ranges.length - 2);
      const request = differentialDownloader.httpExecutor.createRequest(requestOptions, (response) => {
        if (!checkIsRangesSupported(response, reject)) {
          return;
        }
        const contentType = (0, builder_util_runtime_1.safeGetHeader)(response, "content-type");
        const m = /^multipart\/.+?\s*;\s*boundary=(?:"([^"]+)"|([^\s";]+))\s*$/i.exec(contentType);
        if (m == null) {
          reject(new Error(`Content-Type "multipart/byteranges" is expected, but got "${contentType}"`));
          return;
        }
        const dicer = new DataSplitter_1.DataSplitter(out, options, partIndexToTaskIndex, m[1] || m[2], partIndexToLength, resolve, grandTotalBytes, differentialDownloader.options.onProgress);
        dicer.on("error", reject);
        response.pipe(dicer);
        response.on("end", () => {
          setTimeout(() => {
            request.abort();
            reject(new Error("Response ends without calling any handlers"));
          }, 1e4);
        });
      });
      differentialDownloader.httpExecutor.addErrorAndTimeoutHandlers(request, reject);
      request.end();
    }
    function checkIsRangesSupported(response, reject) {
      if (response.statusCode >= 400) {
        reject((0, builder_util_runtime_1.createHttpError)(response));
        return false;
      }
      if (response.statusCode !== 206) {
        const acceptRanges = (0, builder_util_runtime_1.safeGetHeader)(response, "accept-ranges");
        if (acceptRanges == null || acceptRanges === "none") {
          reject(new Error(`Server doesn't support Accept-Ranges (response code ${response.statusCode})`));
          return false;
        }
      }
      return true;
    }
  }
});

// node_modules/.pnpm/electron-updater@6.8.9/node_modules/electron-updater/out/differentialDownloader/ProgressDifferentialDownloadCallbackTransform.js
var require_ProgressDifferentialDownloadCallbackTransform = __commonJS({
  "node_modules/.pnpm/electron-updater@6.8.9/node_modules/electron-updater/out/differentialDownloader/ProgressDifferentialDownloadCallbackTransform.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.ProgressDifferentialDownloadCallbackTransform = void 0;
    var stream_1 = require("stream");
    var OperationKind;
    (function(OperationKind2) {
      OperationKind2[OperationKind2["COPY"] = 0] = "COPY";
      OperationKind2[OperationKind2["DOWNLOAD"] = 1] = "DOWNLOAD";
    })(OperationKind || (OperationKind = {}));
    var ProgressDifferentialDownloadCallbackTransform = class extends stream_1.Transform {
      constructor(progressDifferentialDownloadInfo, cancellationToken, onProgress) {
        super();
        this.progressDifferentialDownloadInfo = progressDifferentialDownloadInfo;
        this.cancellationToken = cancellationToken;
        this.onProgress = onProgress;
        this.start = Date.now();
        this.transferred = 0;
        this.delta = 0;
        this.expectedBytes = 0;
        this.index = 0;
        this.operationType = OperationKind.COPY;
        this.nextUpdate = this.start + 1e3;
      }
      _transform(chunk, encoding, callback) {
        if (this.cancellationToken.cancelled) {
          callback(new Error("cancelled"), null);
          return;
        }
        if (this.operationType == OperationKind.COPY) {
          callback(null, chunk);
          return;
        }
        this.transferred += chunk.length;
        this.delta += chunk.length;
        const now = Date.now();
        if (now >= this.nextUpdate && this.transferred !== this.expectedBytes && this.transferred !== this.progressDifferentialDownloadInfo.grandTotal) {
          this.nextUpdate = now + 1e3;
          this.onProgress({
            total: this.progressDifferentialDownloadInfo.grandTotal,
            delta: this.delta,
            transferred: this.transferred,
            percent: this.transferred / this.progressDifferentialDownloadInfo.grandTotal * 100,
            bytesPerSecond: Math.round(this.transferred / ((now - this.start) / 1e3))
          });
          this.delta = 0;
        }
        callback(null, chunk);
      }
      beginFileCopy() {
        this.operationType = OperationKind.COPY;
      }
      beginRangeDownload() {
        this.operationType = OperationKind.DOWNLOAD;
        this.expectedBytes += this.progressDifferentialDownloadInfo.expectedByteCounts[this.index++];
      }
      endRangeDownload() {
        if (this.transferred !== this.progressDifferentialDownloadInfo.grandTotal) {
          this.onProgress({
            total: this.progressDifferentialDownloadInfo.grandTotal,
            delta: this.delta,
            transferred: this.transferred,
            percent: this.transferred / this.progressDifferentialDownloadInfo.grandTotal * 100,
            bytesPerSecond: Math.round(this.transferred / ((Date.now() - this.start) / 1e3))
          });
        }
      }
      // Called when we are 100% done with the connection/download
      _flush(callback) {
        if (this.cancellationToken.cancelled) {
          callback(new Error("cancelled"));
          return;
        }
        this.onProgress({
          total: this.progressDifferentialDownloadInfo.grandTotal,
          delta: this.delta,
          transferred: this.transferred,
          percent: 100,
          bytesPerSecond: Math.round(this.transferred / ((Date.now() - this.start) / 1e3))
        });
        this.delta = 0;
        this.transferred = 0;
        callback(null);
      }
    };
    exports2.ProgressDifferentialDownloadCallbackTransform = ProgressDifferentialDownloadCallbackTransform;
  }
});

// node_modules/.pnpm/electron-updater@6.8.9/node_modules/electron-updater/out/differentialDownloader/DifferentialDownloader.js
var require_DifferentialDownloader = __commonJS({
  "node_modules/.pnpm/electron-updater@6.8.9/node_modules/electron-updater/out/differentialDownloader/DifferentialDownloader.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.DifferentialDownloader = void 0;
    var builder_util_runtime_1 = require_out();
    var fs_extra_12 = require_lib();
    var fs_1 = require("fs");
    var DataSplitter_1 = require_DataSplitter();
    var url_1 = require("url");
    var downloadPlanBuilder_1 = require_downloadPlanBuilder();
    var multipleRangeDownloader_1 = require_multipleRangeDownloader();
    var ProgressDifferentialDownloadCallbackTransform_1 = require_ProgressDifferentialDownloadCallbackTransform();
    var DifferentialDownloader = class {
      // noinspection TypeScriptAbstractClassConstructorCanBeMadeProtected
      constructor(blockAwareFileInfo, httpExecutor, options) {
        this.blockAwareFileInfo = blockAwareFileInfo;
        this.httpExecutor = httpExecutor;
        this.options = options;
        this.fileMetadataBuffer = null;
        this.logger = options.logger;
      }
      createRequestOptions() {
        const result = {
          headers: {
            ...this.options.requestHeaders,
            accept: "*/*"
          }
        };
        (0, builder_util_runtime_1.configureRequestUrl)(this.options.newUrl, result);
        (0, builder_util_runtime_1.configureRequestOptions)(result);
        return result;
      }
      doDownload(oldBlockMap, newBlockMap) {
        if (oldBlockMap.version !== newBlockMap.version) {
          throw new Error(`version is different (${oldBlockMap.version} - ${newBlockMap.version}), full download is required`);
        }
        const logger = this.logger;
        const operations = (0, downloadPlanBuilder_1.computeOperations)(oldBlockMap, newBlockMap, logger);
        if (logger.debug != null) {
          logger.debug(JSON.stringify(operations, null, 2));
        }
        let downloadSize = 0;
        let copySize = 0;
        for (const operation of operations) {
          const length = operation.end - operation.start;
          if (operation.kind === downloadPlanBuilder_1.OperationKind.DOWNLOAD) {
            downloadSize += length;
          } else {
            copySize += length;
          }
        }
        const newSize = this.blockAwareFileInfo.size;
        if (downloadSize + copySize + (this.fileMetadataBuffer == null ? 0 : this.fileMetadataBuffer.length) !== newSize) {
          throw new Error(`Internal error, size mismatch: downloadSize: ${downloadSize}, copySize: ${copySize}, newSize: ${newSize}`);
        }
        logger.info(`Full: ${formatBytes(newSize)}, To download: ${formatBytes(downloadSize)} (${Math.round(downloadSize / (newSize / 100))}%)`);
        return this.downloadFile(operations);
      }
      downloadFile(tasks) {
        const fdList = [];
        const closeFiles = () => {
          return Promise.all(fdList.map((openedFile) => {
            return (0, fs_extra_12.close)(openedFile.descriptor).catch((e) => {
              this.logger.error(`cannot close file "${openedFile.path}": ${e}`);
            });
          }));
        };
        return this.doDownloadFile(tasks, fdList).then(closeFiles).catch((e) => {
          return closeFiles().catch((closeFilesError) => {
            try {
              this.logger.error(`cannot close files: ${closeFilesError}`);
            } catch (errorOnLog) {
              try {
                console.error(errorOnLog);
              } catch (_ignored) {
              }
            }
            throw e;
          }).then(() => {
            throw e;
          });
        });
      }
      async doDownloadFile(tasks, fdList) {
        const oldFileFd = await (0, fs_extra_12.open)(this.options.oldFile, "r");
        fdList.push({ descriptor: oldFileFd, path: this.options.oldFile });
        const newFileFd = await (0, fs_extra_12.open)(this.options.newFile, "w");
        fdList.push({ descriptor: newFileFd, path: this.options.newFile });
        const fileOut = (0, fs_1.createWriteStream)(this.options.newFile, { fd: newFileFd });
        await new Promise((resolve, reject) => {
          const streams = [];
          let downloadInfoTransform = void 0;
          if (!this.options.isUseMultipleRangeRequest && this.options.onProgress) {
            const expectedByteCounts = [];
            let grandTotalBytes = 0;
            for (const task of tasks) {
              if (task.kind === downloadPlanBuilder_1.OperationKind.DOWNLOAD) {
                expectedByteCounts.push(task.end - task.start);
                grandTotalBytes += task.end - task.start;
              }
            }
            const progressDifferentialDownloadInfo = {
              expectedByteCounts,
              grandTotal: grandTotalBytes
            };
            downloadInfoTransform = new ProgressDifferentialDownloadCallbackTransform_1.ProgressDifferentialDownloadCallbackTransform(progressDifferentialDownloadInfo, this.options.cancellationToken, this.options.onProgress);
            streams.push(downloadInfoTransform);
          }
          const digestTransform = new builder_util_runtime_1.DigestTransform(this.blockAwareFileInfo.sha512);
          digestTransform.isValidateOnEnd = false;
          streams.push(digestTransform);
          fileOut.on("finish", () => {
            ;
            fileOut.close(() => {
              fdList.splice(1, 1);
              try {
                digestTransform.validate();
              } catch (e) {
                reject(e);
                return;
              }
              resolve(void 0);
            });
          });
          streams.push(fileOut);
          let lastStream = null;
          for (const stream of streams) {
            stream.on("error", reject);
            if (lastStream == null) {
              lastStream = stream;
            } else {
              lastStream = lastStream.pipe(stream);
            }
          }
          const firstStream = streams[0];
          let w;
          if (this.options.isUseMultipleRangeRequest) {
            w = (0, multipleRangeDownloader_1.executeTasksUsingMultipleRangeRequests)(this, tasks, firstStream, oldFileFd, reject);
            w(0);
            return;
          }
          let downloadOperationCount = 0;
          let actualUrl = null;
          this.logger.info(`Differential download: ${this.options.newUrl}`);
          const requestOptions = this.createRequestOptions();
          requestOptions.redirect = "manual";
          w = (index) => {
            var _a, _b;
            if (index >= tasks.length) {
              if (this.fileMetadataBuffer != null) {
                firstStream.write(this.fileMetadataBuffer);
              }
              firstStream.end();
              return;
            }
            const operation = tasks[index++];
            if (operation.kind === downloadPlanBuilder_1.OperationKind.COPY) {
              if (downloadInfoTransform) {
                downloadInfoTransform.beginFileCopy();
              }
              (0, DataSplitter_1.copyData)(operation, firstStream, oldFileFd, reject, () => w(index));
              return;
            }
            const range = `bytes=${operation.start}-${operation.end - 1}`;
            requestOptions.headers.range = range;
            (_b = (_a = this.logger) === null || _a === void 0 ? void 0 : _a.debug) === null || _b === void 0 ? void 0 : _b.call(_a, `download range: ${range}`);
            if (downloadInfoTransform) {
              downloadInfoTransform.beginRangeDownload();
            }
            const request = this.httpExecutor.createRequest(requestOptions, (response) => {
              response.on("error", reject);
              response.on("aborted", () => {
                reject(new Error("response has been aborted by the server"));
              });
              if (response.statusCode >= 400) {
                reject((0, builder_util_runtime_1.createHttpError)(response));
              }
              response.pipe(firstStream, {
                end: false
              });
              response.once("end", () => {
                if (downloadInfoTransform) {
                  downloadInfoTransform.endRangeDownload();
                }
                if (++downloadOperationCount === 100) {
                  downloadOperationCount = 0;
                  setTimeout(() => w(index), 1e3);
                } else {
                  w(index);
                }
              });
            });
            request.on("redirect", (statusCode, method, redirectUrl) => {
              this.logger.info(`Redirect to ${removeQuery(redirectUrl)}`);
              actualUrl = redirectUrl;
              (0, builder_util_runtime_1.configureRequestUrl)(new url_1.URL(actualUrl), requestOptions);
              request.followRedirect();
            });
            this.httpExecutor.addErrorAndTimeoutHandlers(request, reject);
            request.end();
          };
          w(0);
        });
      }
      async readRemoteBytes(start, endInclusive) {
        const buffer = Buffer.allocUnsafe(endInclusive + 1 - start);
        const requestOptions = this.createRequestOptions();
        requestOptions.headers.range = `bytes=${start}-${endInclusive}`;
        let position = 0;
        await this.request(requestOptions, (chunk) => {
          chunk.copy(buffer, position);
          position += chunk.length;
        });
        if (position !== buffer.length) {
          throw new Error(`Received data length ${position} is not equal to expected ${buffer.length}`);
        }
        return buffer;
      }
      request(requestOptions, dataHandler) {
        return new Promise((resolve, reject) => {
          const request = this.httpExecutor.createRequest(requestOptions, (response) => {
            if (!(0, multipleRangeDownloader_1.checkIsRangesSupported)(response, reject)) {
              return;
            }
            response.on("error", reject);
            response.on("aborted", () => {
              reject(new Error("response has been aborted by the server"));
            });
            response.on("data", dataHandler);
            response.on("end", () => resolve());
          });
          this.httpExecutor.addErrorAndTimeoutHandlers(request, reject);
          request.end();
        });
      }
    };
    exports2.DifferentialDownloader = DifferentialDownloader;
    function formatBytes(value, symbol = " KB") {
      return new Intl.NumberFormat("en").format((value / 1024).toFixed(2)) + symbol;
    }
    function removeQuery(url) {
      const index = url.indexOf("?");
      return index < 0 ? url : url.substring(0, index);
    }
  }
});

// node_modules/.pnpm/electron-updater@6.8.9/node_modules/electron-updater/out/differentialDownloader/GenericDifferentialDownloader.js
var require_GenericDifferentialDownloader = __commonJS({
  "node_modules/.pnpm/electron-updater@6.8.9/node_modules/electron-updater/out/differentialDownloader/GenericDifferentialDownloader.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.GenericDifferentialDownloader = void 0;
    var DifferentialDownloader_1 = require_DifferentialDownloader();
    var GenericDifferentialDownloader = class extends DifferentialDownloader_1.DifferentialDownloader {
      download(oldBlockMap, newBlockMap) {
        return this.doDownload(oldBlockMap, newBlockMap);
      }
    };
    exports2.GenericDifferentialDownloader = GenericDifferentialDownloader;
  }
});

// node_modules/.pnpm/electron-updater@6.8.9/node_modules/electron-updater/out/types.js
var require_types = __commonJS({
  "node_modules/.pnpm/electron-updater@6.8.9/node_modules/electron-updater/out/types.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.UpdaterSignal = exports2.UPDATE_DOWNLOADED = exports2.DOWNLOAD_PROGRESS = exports2.CancellationToken = void 0;
    exports2.addHandler = addHandler;
    var builder_util_runtime_1 = require_out();
    Object.defineProperty(exports2, "CancellationToken", { enumerable: true, get: function() {
      return builder_util_runtime_1.CancellationToken;
    } });
    exports2.DOWNLOAD_PROGRESS = "download-progress";
    exports2.UPDATE_DOWNLOADED = "update-downloaded";
    var UpdaterSignal = class {
      constructor(emitter) {
        this.emitter = emitter;
      }
      /**
       * Emitted when an authenticating proxy is [asking for user credentials](https://github.com/electron/electron/blob/master/docs/api/client-request.md#event-login).
       */
      login(handler) {
        addHandler(this.emitter, "login", handler);
      }
      progress(handler) {
        addHandler(this.emitter, exports2.DOWNLOAD_PROGRESS, handler);
      }
      updateDownloaded(handler) {
        addHandler(this.emitter, exports2.UPDATE_DOWNLOADED, handler);
      }
      updateCancelled(handler) {
        addHandler(this.emitter, "update-cancelled", handler);
      }
    };
    exports2.UpdaterSignal = UpdaterSignal;
    var isLogEvent = false;
    function addHandler(emitter, event, handler) {
      if (isLogEvent) {
        emitter.on(event, (...args) => {
          console.log("%s %s", event, args);
          handler(...args);
        });
      } else {
        emitter.on(event, handler);
      }
    }
  }
});

// node_modules/.pnpm/electron-updater@6.8.9/node_modules/electron-updater/out/AppUpdater.js
var require_AppUpdater = __commonJS({
  "node_modules/.pnpm/electron-updater@6.8.9/node_modules/electron-updater/out/AppUpdater.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.NoOpLogger = exports2.AppUpdater = void 0;
    var builder_util_runtime_1 = require_out();
    var crypto_1 = require("crypto");
    var os_1 = require("os");
    var events_1 = require("events");
    var fs_extra_12 = require_lib();
    var js_yaml_1 = require_js_yaml_cjs();
    var lazy_val_1 = require_main();
    var path2 = require("path");
    var semver_1 = require_semver2();
    var DownloadedUpdateHelper_1 = require_DownloadedUpdateHelper();
    var ElectronAppAdapter_1 = require_ElectronAppAdapter();
    var electronHttpExecutor_1 = require_electronHttpExecutor();
    var GenericProvider_1 = require_GenericProvider();
    var providerFactory_1 = require_providerFactory();
    var zlib_1 = require("zlib");
    var GenericDifferentialDownloader_1 = require_GenericDifferentialDownloader();
    var types_1 = require_types();
    var AppUpdater = class _AppUpdater extends events_1.EventEmitter {
      /**
       * Get the update channel. Doesn't return `channel` from the update configuration, only if was previously set.
       */
      get channel() {
        return this._channel;
      }
      /**
       * Set the update channel. Overrides `channel` in the update configuration.
       *
       * `allowDowngrade` will be automatically set to `true`. If this behavior is not suitable for you, simple set `allowDowngrade` explicitly after.
       */
      set channel(value) {
        if (this._channel != null) {
          if (typeof value !== "string") {
            throw (0, builder_util_runtime_1.newError)(`Channel must be a string, but got: ${value}`, "ERR_UPDATER_INVALID_CHANNEL");
          } else if (value.length === 0) {
            throw (0, builder_util_runtime_1.newError)(`Channel must be not an empty string`, "ERR_UPDATER_INVALID_CHANNEL");
          }
        }
        this._channel = value;
        this.allowDowngrade = true;
      }
      /**
       *  Shortcut for explicitly adding auth tokens to request headers
       */
      addAuthHeader(token) {
        this.requestHeaders = Object.assign({}, this.requestHeaders, {
          authorization: token
        });
      }
      // noinspection JSMethodCanBeStatic,JSUnusedGlobalSymbols
      get netSession() {
        return (0, electronHttpExecutor_1.getNetSession)();
      }
      /**
       * The logger. You can pass [electron-log](https://github.com/megahertz/electron-log), [winston](https://github.com/winstonjs/winston) or another logger with the following interface: `{ info(), warn(), error() }`.
       * Set it to `null` if you would like to disable a logging feature.
       */
      get logger() {
        return this._logger;
      }
      set logger(value) {
        this._logger = value == null ? new NoOpLogger() : value;
      }
      // noinspection JSUnusedGlobalSymbols
      /**
       * test only
       * @private
       */
      set updateConfigPath(value) {
        this.clientPromise = null;
        this._appUpdateConfigPath = value;
        this.configOnDisk = new lazy_val_1.Lazy(() => this.loadUpdateConfig());
      }
      /**
       * Allows developer to override default logic for determining if an update is supported.
       * The default logic compares the `UpdateInfo` minimum system version against the `os.release()` with `semver` package
       */
      get isUpdateSupported() {
        return this._isUpdateSupported;
      }
      set isUpdateSupported(value) {
        if (value) {
          this._isUpdateSupported = value;
        }
      }
      /**
       * Allows developer to override default logic for determining if the user is below the rollout threshold.
       * The default logic compares the staging percentage with numerical representation of user ID.
       * An override can define custom logic, or bypass it if needed.
       */
      get isUserWithinRollout() {
        return this._isUserWithinRollout;
      }
      set isUserWithinRollout(value) {
        if (value) {
          this._isUserWithinRollout = value;
        }
      }
      constructor(options, app) {
        super();
        this.autoDownload = true;
        this.autoInstallOnAppQuit = true;
        this.autoRunAppAfterInstall = true;
        this.allowPrerelease = false;
        this.fullChangelog = false;
        this.allowDowngrade = false;
        this.disableWebInstaller = false;
        this.disableDifferentialDownload = false;
        this.forceDevUpdateConfig = false;
        this.previousBlockmapBaseUrlOverride = null;
        this._channel = null;
        this.downloadedUpdateHelper = null;
        this.requestHeaders = null;
        this._logger = console;
        this.signals = new types_1.UpdaterSignal(this);
        this._appUpdateConfigPath = null;
        this._isUpdateSupported = (updateInfo) => this.checkIfUpdateSupported(updateInfo);
        this._isUserWithinRollout = (updateInfo) => this.isStagingMatch(updateInfo);
        this.clientPromise = null;
        this.stagingUserIdPromise = new lazy_val_1.Lazy(() => this.getOrCreateStagingUserId());
        this.configOnDisk = new lazy_val_1.Lazy(() => this.loadUpdateConfig());
        this.checkForUpdatesPromise = null;
        this.downloadPromise = null;
        this.updateInfoAndProvider = null;
        this._testOnlyOptions = null;
        this.on("error", (error) => {
          this._logger.error(`Error: ${error.stack || error.message}`);
        });
        if (app == null) {
          this.app = new ElectronAppAdapter_1.ElectronAppAdapter();
          this.httpExecutor = new electronHttpExecutor_1.ElectronHttpExecutor((authInfo, callback) => this.emit("login", authInfo, callback));
        } else {
          this.app = app;
          this.httpExecutor = null;
        }
        const currentVersionString = this.app.version;
        const currentVersion = (0, semver_1.parse)(currentVersionString);
        if (currentVersion == null) {
          throw (0, builder_util_runtime_1.newError)(`App version is not a valid semver version: "${currentVersionString}"`, "ERR_UPDATER_INVALID_VERSION");
        }
        this.currentVersion = currentVersion;
        this.allowPrerelease = hasPrereleaseComponents(currentVersion);
        if (options != null) {
          this.setFeedURL(options);
          if (typeof options !== "string" && options.requestHeaders) {
            this.requestHeaders = options.requestHeaders;
          }
        }
      }
      //noinspection JSMethodCanBeStatic,JSUnusedGlobalSymbols
      getFeedURL() {
        return "Deprecated. Do not use it.";
      }
      /**
       * Configure update provider. If value is `string`, [GenericServerOptions](https://www.electron.build/publish#genericserveroptions) will be set with value as `url`.
       * @param options If you want to override configuration in the `app-update.yml`.
       */
      setFeedURL(options) {
        const runtimeOptions = this.createProviderRuntimeOptions();
        let provider;
        if (typeof options === "string") {
          provider = new GenericProvider_1.GenericProvider({ provider: "generic", url: options }, this, {
            ...runtimeOptions,
            isUseMultipleRangeRequest: (0, providerFactory_1.isUrlProbablySupportMultiRangeRequests)(options)
          });
        } else {
          provider = (0, providerFactory_1.createClient)(options, this, runtimeOptions);
        }
        this.clientPromise = Promise.resolve(provider);
      }
      /**
       * Asks the server whether there is an update.
       * @returns null if the updater is disabled, otherwise info about the latest version
       */
      checkForUpdates() {
        if (!this.isUpdaterActive()) {
          return Promise.resolve(null);
        }
        let checkForUpdatesPromise = this.checkForUpdatesPromise;
        if (checkForUpdatesPromise != null) {
          this._logger.info("Checking for update (already in progress)");
          return checkForUpdatesPromise;
        }
        const nullizePromise = () => this.checkForUpdatesPromise = null;
        this._logger.info("Checking for update");
        checkForUpdatesPromise = this.doCheckForUpdates().then((it) => {
          nullizePromise();
          return it;
        }).catch((e) => {
          nullizePromise();
          this.emit("error", e, `Cannot check for updates: ${(e.stack || e).toString()}`);
          throw e;
        });
        this.checkForUpdatesPromise = checkForUpdatesPromise;
        return checkForUpdatesPromise;
      }
      isUpdaterActive() {
        const isEnabled = this.app.isPackaged || this.forceDevUpdateConfig;
        if (!isEnabled) {
          this._logger.info("Skip checkForUpdates because application is not packed and dev update config is not forced");
          return false;
        }
        return true;
      }
      // noinspection JSUnusedGlobalSymbols
      checkForUpdatesAndNotify(downloadNotification) {
        return this.checkForUpdates().then((it) => {
          if (!(it === null || it === void 0 ? void 0 : it.downloadPromise)) {
            if (this._logger.debug != null) {
              this._logger.debug("checkForUpdatesAndNotify called, downloadPromise is null");
            }
            return it;
          }
          void it.downloadPromise.then(() => {
            const notificationContent = _AppUpdater.formatDownloadNotification(it.updateInfo.version, this.app.name, downloadNotification);
            new (require("electron")).Notification(notificationContent).show();
          });
          return it;
        });
      }
      static formatDownloadNotification(version, appName, downloadNotification) {
        if (downloadNotification == null) {
          downloadNotification = {
            title: "A new update is ready to install",
            body: `{appName} version {version} has been downloaded and will be automatically installed on exit`
          };
        }
        downloadNotification = {
          title: downloadNotification.title.replace("{appName}", appName).replace("{version}", version),
          body: downloadNotification.body.replace("{appName}", appName).replace("{version}", version)
        };
        return downloadNotification;
      }
      async isStagingMatch(updateInfo) {
        const rawStagingPercentage = updateInfo.stagingPercentage;
        let stagingPercentage = rawStagingPercentage;
        if (stagingPercentage == null) {
          return true;
        }
        stagingPercentage = parseInt(stagingPercentage, 10);
        if (isNaN(stagingPercentage)) {
          this._logger.warn(`Staging percentage is NaN: ${rawStagingPercentage}`);
          return true;
        }
        stagingPercentage = stagingPercentage / 100;
        const stagingUserId = await this.stagingUserIdPromise.value;
        const val = builder_util_runtime_1.UUID.parse(stagingUserId).readUInt32BE(12);
        const percentage = val / 4294967295;
        this._logger.info(`Staging percentage: ${stagingPercentage}, percentage: ${percentage}, user id: ${stagingUserId}`);
        return percentage < stagingPercentage;
      }
      computeFinalHeaders(headers) {
        if (this.requestHeaders != null) {
          Object.assign(headers, this.requestHeaders);
        }
        return headers;
      }
      async isUpdateAvailable(updateInfo) {
        const latestVersion = (0, semver_1.parse)(updateInfo.version);
        if (latestVersion == null) {
          throw (0, builder_util_runtime_1.newError)(`This file could not be downloaded, or the latest version (from update server) does not have a valid semver version: "${updateInfo.version}"`, "ERR_UPDATER_INVALID_VERSION");
        }
        const currentVersion = this.currentVersion;
        if ((0, semver_1.eq)(latestVersion, currentVersion)) {
          return false;
        }
        if (!await Promise.resolve(this.isUpdateSupported(updateInfo))) {
          return false;
        }
        const isUserWithinRollout = await Promise.resolve(this.isUserWithinRollout(updateInfo));
        if (!isUserWithinRollout) {
          return false;
        }
        const isLatestVersionNewer = (0, semver_1.gt)(latestVersion, currentVersion);
        const isLatestVersionOlder = (0, semver_1.lt)(latestVersion, currentVersion);
        if (isLatestVersionNewer) {
          return true;
        }
        return this.allowDowngrade && isLatestVersionOlder;
      }
      checkIfUpdateSupported(updateInfo) {
        const minimumSystemVersion = updateInfo === null || updateInfo === void 0 ? void 0 : updateInfo.minimumSystemVersion;
        const currentOSVersion = (0, os_1.release)();
        if (minimumSystemVersion) {
          try {
            if ((0, semver_1.lt)(currentOSVersion, minimumSystemVersion)) {
              this._logger.info(`Current OS version ${currentOSVersion} is less than the minimum OS version required ${minimumSystemVersion} for version ${currentOSVersion}`);
              return false;
            }
          } catch (e) {
            this._logger.warn(`Failed to compare current OS version(${currentOSVersion}) with minimum OS version(${minimumSystemVersion}): ${(e.message || e).toString()}`);
          }
        }
        return true;
      }
      async getUpdateInfoAndProvider() {
        await this.app.whenReady();
        if (this.clientPromise == null) {
          this.clientPromise = this.configOnDisk.value.then((it) => (0, providerFactory_1.createClient)(it, this, this.createProviderRuntimeOptions()));
        }
        const client = await this.clientPromise;
        const stagingUserId = await this.stagingUserIdPromise.value;
        client.setRequestHeaders(this.computeFinalHeaders({ "x-user-staging-id": stagingUserId }));
        return {
          info: await client.getLatestVersion(),
          provider: client
        };
      }
      createProviderRuntimeOptions() {
        return {
          isUseMultipleRangeRequest: true,
          platform: this._testOnlyOptions == null ? process.platform : this._testOnlyOptions.platform,
          executor: this.httpExecutor
        };
      }
      async doCheckForUpdates() {
        this.emit("checking-for-update");
        const result = await this.getUpdateInfoAndProvider();
        const updateInfo = result.info;
        if (!await this.isUpdateAvailable(updateInfo)) {
          this._logger.info(`Update for version ${this.currentVersion.format()} is not available (latest version: ${updateInfo.version}, downgrade is ${this.allowDowngrade ? "allowed" : "disallowed"}).`);
          this.emit("update-not-available", updateInfo);
          return {
            isUpdateAvailable: false,
            versionInfo: updateInfo,
            updateInfo
          };
        }
        this.updateInfoAndProvider = result;
        this.onUpdateAvailable(updateInfo);
        const cancellationToken = new builder_util_runtime_1.CancellationToken();
        return {
          isUpdateAvailable: true,
          versionInfo: updateInfo,
          updateInfo,
          cancellationToken,
          downloadPromise: this.autoDownload ? this.downloadUpdate(cancellationToken) : null
        };
      }
      onUpdateAvailable(updateInfo) {
        this._logger.info(`Found version ${updateInfo.version} (url: ${(0, builder_util_runtime_1.asArray)(updateInfo.files).map((it) => it.url).join(", ")})`);
        this.emit("update-available", updateInfo);
      }
      /**
       * Start downloading update manually. You can use this method if `autoDownload` option is set to `false`.
       * @returns {Promise<Array<string>>} Paths to downloaded files.
       */
      downloadUpdate(cancellationToken = new builder_util_runtime_1.CancellationToken()) {
        const updateInfoAndProvider = this.updateInfoAndProvider;
        if (updateInfoAndProvider == null) {
          const error = new Error("Please check update first");
          this.dispatchError(error);
          return Promise.reject(error);
        }
        if (this.downloadPromise != null) {
          this._logger.info("Downloading update (already in progress)");
          return this.downloadPromise;
        }
        this._logger.info(`Downloading update from ${(0, builder_util_runtime_1.asArray)(updateInfoAndProvider.info.files).map((it) => it.url).join(", ")}`);
        const errorHandler = (e) => {
          if (!(e instanceof builder_util_runtime_1.CancellationError)) {
            try {
              this.dispatchError(e);
            } catch (nestedError) {
              this._logger.warn(`Cannot dispatch error event: ${nestedError.stack || nestedError}`);
            }
          }
          return e;
        };
        this.downloadPromise = this.doDownloadUpdate({
          updateInfoAndProvider,
          requestHeaders: this.computeRequestHeaders(updateInfoAndProvider.provider),
          cancellationToken,
          disableWebInstaller: this.disableWebInstaller,
          disableDifferentialDownload: this.disableDifferentialDownload
        }).catch((e) => {
          throw errorHandler(e);
        }).finally(() => {
          this.downloadPromise = null;
        });
        return this.downloadPromise;
      }
      dispatchError(e) {
        this.emit("error", e, (e.stack || e).toString());
      }
      dispatchUpdateDownloaded(event) {
        this.emit(types_1.UPDATE_DOWNLOADED, event);
      }
      async loadUpdateConfig() {
        if (this._appUpdateConfigPath == null) {
          this._appUpdateConfigPath = this.app.appUpdateConfigPath;
        }
        return (0, js_yaml_1.load)(await (0, fs_extra_12.readFile)(this._appUpdateConfigPath, "utf-8"));
      }
      computeRequestHeaders(provider) {
        const fileExtraDownloadHeaders = provider.fileExtraDownloadHeaders;
        if (fileExtraDownloadHeaders != null) {
          const requestHeaders = this.requestHeaders;
          return requestHeaders == null ? fileExtraDownloadHeaders : {
            ...fileExtraDownloadHeaders,
            ...requestHeaders
          };
        }
        return this.computeFinalHeaders({ accept: "*/*" });
      }
      async getOrCreateStagingUserId() {
        const file = path2.join(this.app.userDataPath, ".updaterId");
        try {
          const id2 = await (0, fs_extra_12.readFile)(file, "utf-8");
          if (builder_util_runtime_1.UUID.check(id2)) {
            return id2;
          } else {
            this._logger.warn(`Staging user id file exists, but content was invalid: ${id2}`);
          }
        } catch (e) {
          if (e.code !== "ENOENT") {
            this._logger.warn(`Couldn't read staging user ID, creating a blank one: ${e}`);
          }
        }
        const id = builder_util_runtime_1.UUID.v5((0, crypto_1.randomBytes)(4096), builder_util_runtime_1.UUID.OID);
        this._logger.info(`Generated new staging user ID: ${id}`);
        try {
          await (0, fs_extra_12.outputFile)(file, id);
        } catch (e) {
          this._logger.warn(`Couldn't write out staging user ID: ${e}`);
        }
        return id;
      }
      /** @internal */
      get isAddNoCacheQuery() {
        const headers = this.requestHeaders;
        if (headers == null) {
          return true;
        }
        for (const headerName of Object.keys(headers)) {
          const s = headerName.toLowerCase();
          if (s === "authorization" || s === "private-token") {
            return false;
          }
        }
        return true;
      }
      async getOrCreateDownloadHelper() {
        let result = this.downloadedUpdateHelper;
        if (result == null) {
          const dirName = (await this.configOnDisk.value).updaterCacheDirName;
          const logger = this._logger;
          if (dirName == null) {
            logger.error("updaterCacheDirName is not specified in app-update.yml Was app build using at least electron-builder 20.34.0?");
          }
          const cacheDir = path2.join(this.app.baseCachePath, dirName || this.app.name);
          if (logger.debug != null) {
            logger.debug(`updater cache dir: ${cacheDir}`);
          }
          result = new DownloadedUpdateHelper_1.DownloadedUpdateHelper(cacheDir);
          this.downloadedUpdateHelper = result;
        }
        return result;
      }
      async executeDownload(taskOptions) {
        const fileInfo = taskOptions.fileInfo;
        const downloadOptions = {
          headers: taskOptions.downloadUpdateOptions.requestHeaders,
          cancellationToken: taskOptions.downloadUpdateOptions.cancellationToken,
          sha2: fileInfo.info.sha2,
          sha512: fileInfo.info.sha512
        };
        if (this.listenerCount(types_1.DOWNLOAD_PROGRESS) > 0) {
          downloadOptions.onProgress = (it) => this.emit(types_1.DOWNLOAD_PROGRESS, it);
        }
        const updateInfo = taskOptions.downloadUpdateOptions.updateInfoAndProvider.info;
        const version = updateInfo.version;
        const packageInfo = fileInfo.packageInfo;
        function getCacheUpdateFileName() {
          const urlPath = decodeURIComponent(taskOptions.fileInfo.url.pathname);
          if (urlPath.toLowerCase().endsWith(`.${taskOptions.fileExtension.toLowerCase()}`)) {
            return path2.basename(urlPath);
          } else {
            return path2.basename(taskOptions.fileInfo.info.url);
          }
        }
        const downloadedUpdateHelper = await this.getOrCreateDownloadHelper();
        const cacheDir = downloadedUpdateHelper.cacheDirForPendingUpdate;
        await (0, fs_extra_12.mkdir)(cacheDir, { recursive: true });
        const updateFileName = getCacheUpdateFileName();
        let updateFile = path2.join(cacheDir, updateFileName);
        const packageFile = packageInfo == null ? null : path2.join(cacheDir, `package-${version}${path2.extname(packageInfo.path) || ".7z"}`);
        const done = async (isSaveCache) => {
          await downloadedUpdateHelper.setDownloadedFile(updateFile, packageFile, updateInfo, fileInfo, updateFileName, isSaveCache);
          await taskOptions.done({
            ...updateInfo,
            downloadedFile: updateFile
          });
          const currentBlockMapFile = path2.join(cacheDir, "current.blockmap");
          if (await (0, fs_extra_12.pathExists)(currentBlockMapFile)) {
            await (0, fs_extra_12.copyFile)(currentBlockMapFile, path2.join(downloadedUpdateHelper.cacheDir, "current.blockmap"));
          }
          return packageFile == null ? [updateFile] : [updateFile, packageFile];
        };
        const log = this._logger;
        const cachedUpdateFile = await downloadedUpdateHelper.validateDownloadedPath(updateFile, updateInfo, fileInfo, log);
        if (cachedUpdateFile != null) {
          updateFile = cachedUpdateFile;
          return await done(false);
        }
        const removeFileIfAny = async () => {
          await downloadedUpdateHelper.clear().catch(() => {
          });
          return await (0, fs_extra_12.unlink)(updateFile).catch(() => {
          });
        };
        const tempUpdateFile = await (0, DownloadedUpdateHelper_1.createTempUpdateFile)(`temp-${updateFileName}`, cacheDir, log);
        try {
          await taskOptions.task(tempUpdateFile, downloadOptions, packageFile, removeFileIfAny);
          await (0, builder_util_runtime_1.retry)(() => (0, fs_extra_12.rename)(tempUpdateFile, updateFile), {
            retries: 60,
            interval: 500,
            shouldRetry: (error) => {
              if (error instanceof Error && /^EBUSY:/.test(error.message)) {
                return true;
              }
              log.warn(`Cannot rename temp file to final file: ${error.message || error.stack}`);
              return false;
            }
          });
        } catch (e) {
          await removeFileIfAny();
          if (e instanceof builder_util_runtime_1.CancellationError) {
            log.info("cancelled");
            this.emit("update-cancelled", updateInfo);
          }
          throw e;
        }
        log.info(`New version ${version} has been downloaded to ${updateFile}`);
        return await done(true);
      }
      async differentialDownloadInstaller(fileInfo, downloadUpdateOptions, installerPath, provider, oldInstallerFileName) {
        try {
          if (this._testOnlyOptions != null && !this._testOnlyOptions.isUseDifferentialDownload) {
            return true;
          }
          const provider2 = downloadUpdateOptions.updateInfoAndProvider.provider;
          const blockmapFileUrls = await provider2.getBlockMapFiles(fileInfo.url, this.app.version, downloadUpdateOptions.updateInfoAndProvider.info.version, this.previousBlockmapBaseUrlOverride);
          this._logger.info(`Download block maps (old: "${blockmapFileUrls[0]}", new: ${blockmapFileUrls[1]})`);
          const downloadBlockMap = async (url) => {
            const data = await this.httpExecutor.downloadToBuffer(url, {
              headers: downloadUpdateOptions.requestHeaders,
              cancellationToken: downloadUpdateOptions.cancellationToken
            });
            if (data == null || data.length === 0) {
              throw new Error(`Blockmap "${url.href}" is empty`);
            }
            try {
              return JSON.parse((0, zlib_1.gunzipSync)(data).toString());
            } catch (e) {
              throw new Error(`Cannot parse blockmap "${url.href}", error: ${e}`);
            }
          };
          const downloadOptions = {
            newUrl: fileInfo.url,
            oldFile: path2.join(this.downloadedUpdateHelper.cacheDir, oldInstallerFileName),
            logger: this._logger,
            newFile: installerPath,
            isUseMultipleRangeRequest: provider2.isUseMultipleRangeRequest,
            requestHeaders: downloadUpdateOptions.requestHeaders,
            cancellationToken: downloadUpdateOptions.cancellationToken
          };
          if (this.listenerCount(types_1.DOWNLOAD_PROGRESS) > 0) {
            downloadOptions.onProgress = (it) => this.emit(types_1.DOWNLOAD_PROGRESS, it);
          }
          const saveBlockMapToCacheDir = async (blockMapData, cacheDir) => {
            const blockMapFile = path2.join(cacheDir, "current.blockmap");
            await (0, fs_extra_12.outputFile)(blockMapFile, (0, zlib_1.gzipSync)(JSON.stringify(blockMapData)));
          };
          const getBlockMapFromCacheDir = async (cacheDir) => {
            const blockMapFile = path2.join(cacheDir, "current.blockmap");
            try {
              if (await (0, fs_extra_12.pathExists)(blockMapFile)) {
                return JSON.parse((0, zlib_1.gunzipSync)(await (0, fs_extra_12.readFile)(blockMapFile)).toString());
              }
            } catch (e) {
              this._logger.warn(`Cannot parse blockmap "${blockMapFile}", error: ${e}`);
            }
            return null;
          };
          const newBlockMapData = await downloadBlockMap(blockmapFileUrls[1]);
          await saveBlockMapToCacheDir(newBlockMapData, this.downloadedUpdateHelper.cacheDirForPendingUpdate);
          let oldBlockMapData = await getBlockMapFromCacheDir(this.downloadedUpdateHelper.cacheDir);
          if (oldBlockMapData == null) {
            oldBlockMapData = await downloadBlockMap(blockmapFileUrls[0]);
          }
          await new GenericDifferentialDownloader_1.GenericDifferentialDownloader(fileInfo.info, this.httpExecutor, downloadOptions).download(oldBlockMapData, newBlockMapData);
          return false;
        } catch (e) {
          this._logger.error(`Cannot download differentially, fallback to full download: ${e.stack || e}`);
          if (this._testOnlyOptions != null) {
            throw e;
          }
          return true;
        }
      }
    };
    exports2.AppUpdater = AppUpdater;
    function hasPrereleaseComponents(version) {
      const versionPrereleaseComponent = (0, semver_1.prerelease)(version);
      return versionPrereleaseComponent != null && versionPrereleaseComponent.length > 0;
    }
    var NoOpLogger = class {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      info(message) {
      }
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      warn(message) {
      }
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      error(message) {
      }
    };
    exports2.NoOpLogger = NoOpLogger;
  }
});

// node_modules/.pnpm/electron-updater@6.8.9/node_modules/electron-updater/out/BaseUpdater.js
var require_BaseUpdater = __commonJS({
  "node_modules/.pnpm/electron-updater@6.8.9/node_modules/electron-updater/out/BaseUpdater.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.BaseUpdater = void 0;
    var child_process_1 = require("child_process");
    var path2 = require("path");
    var AppUpdater_12 = require_AppUpdater();
    var BaseUpdater = class extends AppUpdater_12.AppUpdater {
      constructor(options, app) {
        super(options, app);
        this.quitAndInstallCalled = false;
        this.quitHandlerAdded = false;
      }
      quitAndInstall(isSilent = false, isForceRunAfter = false) {
        this._logger.info(`Install on explicit quitAndInstall`);
        const isInstalled = this.install(isSilent, isSilent ? isForceRunAfter : this.autoRunAppAfterInstall);
        if (isInstalled) {
          setImmediate(() => {
            require("electron").autoUpdater.emit("before-quit-for-update");
            this.app.quit();
          });
        } else {
          this.quitAndInstallCalled = false;
        }
      }
      executeDownload(taskOptions) {
        return super.executeDownload({
          ...taskOptions,
          done: (event) => {
            this.dispatchUpdateDownloaded(event);
            this.addQuitHandler();
            return Promise.resolve();
          }
        });
      }
      get installerPath() {
        return this.downloadedUpdateHelper == null ? null : this.downloadedUpdateHelper.file;
      }
      // must be sync (because quit even handler is not async)
      install(isSilent = false, isForceRunAfter = false) {
        if (this.quitAndInstallCalled) {
          this._logger.warn("install call ignored: quitAndInstallCalled is set to true");
          return false;
        }
        const downloadedUpdateHelper = this.downloadedUpdateHelper;
        const installerPath = this.installerPath;
        const downloadedFileInfo = downloadedUpdateHelper == null ? null : downloadedUpdateHelper.downloadedFileInfo;
        if (installerPath == null || downloadedFileInfo == null) {
          this.dispatchError(new Error("No update filepath provided, can't quit and install"));
          return false;
        }
        this.quitAndInstallCalled = true;
        try {
          this._logger.info(`Install: isSilent: ${isSilent}, isForceRunAfter: ${isForceRunAfter}`);
          return this.doInstall({
            isSilent,
            isForceRunAfter,
            isAdminRightsRequired: downloadedFileInfo.isAdminRightsRequired
          });
        } catch (e) {
          this.dispatchError(e);
          return false;
        }
      }
      addQuitHandler() {
        if (this.quitHandlerAdded || !this.autoInstallOnAppQuit) {
          return;
        }
        this.quitHandlerAdded = true;
        this.app.onQuit((exitCode) => {
          if (this.quitAndInstallCalled) {
            this._logger.info("Update installer has already been triggered. Quitting application.");
            return;
          }
          if (!this.autoInstallOnAppQuit) {
            this._logger.info("Update will not be installed on quit because autoInstallOnAppQuit is set to false.");
            return;
          }
          if (exitCode !== 0) {
            this._logger.info(`Update will be not installed on quit because application is quitting with exit code ${exitCode}`);
            return;
          }
          this._logger.info("Auto install update on quit");
          this.install(true, false);
        });
      }
      /**
       * Strips relative-path entries from a PATH string.
       * Prevents PATH-poisoning where a writable directory earlier in PATH shadows
       * a trusted package manager binary.
       */
      sanitizeEnvPath(envPath) {
        return envPath.split(path2.delimiter).filter((dir) => path2.isAbsolute(dir)).join(path2.delimiter);
      }
      spawnSyncLog(cmd, args = [], env = {}) {
        var _a;
        this._logger.info(`Executing: ${cmd} with args: ${args}`);
        const mergedEnv = { ...process.env, ...env };
        const response = (0, child_process_1.spawnSync)(cmd, args, {
          env: { ...mergedEnv, PATH: this.sanitizeEnvPath((_a = mergedEnv.PATH) !== null && _a !== void 0 ? _a : "") },
          encoding: "utf-8",
          shell: true
        });
        const { error, status, stdout, stderr } = response;
        if (error != null) {
          this._logger.error(stderr);
          throw error;
        } else if (status != null && status !== 0) {
          this._logger.error(stderr);
          throw new Error(`Command ${cmd} exited with code ${status}`);
        }
        return stdout.trim();
      }
      /**
       * This handles both node 8 and node 10 way of emitting error when spawning a process
       *   - node 8: Throws the error
       *   - node 10: Emit the error(Need to listen with on)
       */
      // https://github.com/electron-userland/electron-builder/issues/1129
      // Node 8 sends errors: https://nodejs.org/dist/latest-v8.x/docs/api/errors.html#errors_common_system_errors
      async spawnLog(cmd, args = [], env = void 0, stdio = "ignore") {
        this._logger.info(`Executing: ${cmd} with args: ${args}`);
        return new Promise((resolve, reject) => {
          try {
            const params = { stdio, env, detached: true };
            const p = (0, child_process_1.spawn)(cmd, args, params);
            p.on("error", (error) => {
              reject(error);
            });
            p.unref();
            if (p.pid !== void 0) {
              resolve(true);
            }
          } catch (error) {
            reject(error);
          }
        });
      }
    };
    exports2.BaseUpdater = BaseUpdater;
  }
});

// node_modules/.pnpm/electron-updater@6.8.9/node_modules/electron-updater/out/differentialDownloader/FileWithEmbeddedBlockMapDifferentialDownloader.js
var require_FileWithEmbeddedBlockMapDifferentialDownloader = __commonJS({
  "node_modules/.pnpm/electron-updater@6.8.9/node_modules/electron-updater/out/differentialDownloader/FileWithEmbeddedBlockMapDifferentialDownloader.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.FileWithEmbeddedBlockMapDifferentialDownloader = void 0;
    var fs_extra_12 = require_lib();
    var DifferentialDownloader_1 = require_DifferentialDownloader();
    var zlib_1 = require("zlib");
    var FileWithEmbeddedBlockMapDifferentialDownloader = class extends DifferentialDownloader_1.DifferentialDownloader {
      async download() {
        const packageInfo = this.blockAwareFileInfo;
        const fileSize = packageInfo.size;
        const offset = fileSize - (packageInfo.blockMapSize + 4);
        this.fileMetadataBuffer = await this.readRemoteBytes(offset, fileSize - 1);
        const newBlockMap = readBlockMap(this.fileMetadataBuffer.slice(0, this.fileMetadataBuffer.length - 4));
        await this.doDownload(await readEmbeddedBlockMapData(this.options.oldFile), newBlockMap);
      }
    };
    exports2.FileWithEmbeddedBlockMapDifferentialDownloader = FileWithEmbeddedBlockMapDifferentialDownloader;
    function readBlockMap(data) {
      return JSON.parse((0, zlib_1.inflateRawSync)(data).toString());
    }
    async function readEmbeddedBlockMapData(file) {
      const fd = await (0, fs_extra_12.open)(file, "r");
      try {
        const fileSize = (await (0, fs_extra_12.fstat)(fd)).size;
        const sizeBuffer = Buffer.allocUnsafe(4);
        await (0, fs_extra_12.read)(fd, sizeBuffer, 0, sizeBuffer.length, fileSize - sizeBuffer.length);
        const dataBuffer = Buffer.allocUnsafe(sizeBuffer.readUInt32BE(0));
        await (0, fs_extra_12.read)(fd, dataBuffer, 0, dataBuffer.length, fileSize - sizeBuffer.length - dataBuffer.length);
        await (0, fs_extra_12.close)(fd);
        return readBlockMap(dataBuffer);
      } catch (e) {
        await (0, fs_extra_12.close)(fd);
        throw e;
      }
    }
  }
});

// node_modules/.pnpm/electron-updater@6.8.9/node_modules/electron-updater/out/AppImageUpdater.js
var require_AppImageUpdater = __commonJS({
  "node_modules/.pnpm/electron-updater@6.8.9/node_modules/electron-updater/out/AppImageUpdater.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.AppImageUpdater = void 0;
    var builder_util_runtime_1 = require_out();
    var child_process_1 = require("child_process");
    var fs_extra_12 = require_lib();
    var fs_1 = require("fs");
    var path2 = require("path");
    var BaseUpdater_12 = require_BaseUpdater();
    var FileWithEmbeddedBlockMapDifferentialDownloader_1 = require_FileWithEmbeddedBlockMapDifferentialDownloader();
    var Provider_12 = require_Provider();
    var types_1 = require_types();
    var AppImageUpdater = class extends BaseUpdater_12.BaseUpdater {
      constructor(options, app) {
        super(options, app);
      }
      isUpdaterActive() {
        if (process.env["APPIMAGE"] == null && !this.forceDevUpdateConfig) {
          if (process.env["SNAP"] == null) {
            this._logger.warn("APPIMAGE env is not defined, current application is not an AppImage");
          } else {
            this._logger.info("SNAP env is defined, updater is disabled");
          }
          return false;
        }
        return super.isUpdaterActive();
      }
      /*** @private */
      doDownloadUpdate(downloadUpdateOptions) {
        const provider = downloadUpdateOptions.updateInfoAndProvider.provider;
        const fileInfo = (0, Provider_12.findFile)(provider.resolveFiles(downloadUpdateOptions.updateInfoAndProvider.info), "AppImage", ["rpm", "deb", "pacman"]);
        return this.executeDownload({
          fileExtension: "AppImage",
          fileInfo,
          downloadUpdateOptions,
          task: async (updateFile, downloadOptions) => {
            const oldFile = process.env["APPIMAGE"];
            if (oldFile == null) {
              throw (0, builder_util_runtime_1.newError)("APPIMAGE env is not defined", "ERR_UPDATER_OLD_FILE_NOT_FOUND");
            }
            if (downloadUpdateOptions.disableDifferentialDownload || await this.downloadDifferential(fileInfo, oldFile, updateFile, provider, downloadUpdateOptions)) {
              await this.httpExecutor.download(fileInfo.url, updateFile, downloadOptions);
            }
            await (0, fs_extra_12.chmod)(updateFile, 493);
          }
        });
      }
      async downloadDifferential(fileInfo, oldFile, updateFile, provider, downloadUpdateOptions) {
        try {
          const downloadOptions = {
            newUrl: fileInfo.url,
            oldFile,
            logger: this._logger,
            newFile: updateFile,
            isUseMultipleRangeRequest: provider.isUseMultipleRangeRequest,
            requestHeaders: downloadUpdateOptions.requestHeaders,
            cancellationToken: downloadUpdateOptions.cancellationToken
          };
          if (this.listenerCount(types_1.DOWNLOAD_PROGRESS) > 0) {
            downloadOptions.onProgress = (it) => this.emit(types_1.DOWNLOAD_PROGRESS, it);
          }
          await new FileWithEmbeddedBlockMapDifferentialDownloader_1.FileWithEmbeddedBlockMapDifferentialDownloader(fileInfo.info, this.httpExecutor, downloadOptions).download();
          return false;
        } catch (e) {
          this._logger.error(`Cannot download differentially, fallback to full download: ${e.stack || e}`);
          return process.platform === "linux";
        }
      }
      doInstall(options) {
        const appImageFile = process.env["APPIMAGE"];
        if (appImageFile == null) {
          throw (0, builder_util_runtime_1.newError)("APPIMAGE env is not defined", "ERR_UPDATER_OLD_FILE_NOT_FOUND");
        }
        if (!path2.isAbsolute(appImageFile) || appImageFile.includes("\0")) {
          throw (0, builder_util_runtime_1.newError)(`APPIMAGE env is not a valid absolute path: "${appImageFile}"`, "ERR_UPDATER_OLD_FILE_NOT_FOUND");
        }
        (0, fs_1.unlinkSync)(appImageFile);
        let destination;
        const existingBaseName = path2.basename(appImageFile);
        const installerPath = this.installerPath;
        if (installerPath == null) {
          this.dispatchError(new Error("No update filepath provided, can't quit and install"));
          return false;
        }
        if (path2.basename(installerPath) === existingBaseName || !/\d+\.\d+\.\d+/.test(existingBaseName)) {
          destination = appImageFile;
        } else {
          destination = path2.join(path2.dirname(appImageFile), path2.basename(installerPath));
        }
        (0, child_process_1.execFileSync)("mv", ["-f", installerPath, destination]);
        if (destination !== appImageFile) {
          this.emit("appimage-filename-updated", destination);
        }
        const env = {
          ...process.env,
          APPIMAGE_SILENT_INSTALL: "true"
        };
        if (options.isForceRunAfter) {
          this.spawnLog(destination, [], env);
        } else {
          env.APPIMAGE_EXIT_AFTER_INSTALL = "true";
          (0, child_process_1.execFileSync)(destination, [], { env });
        }
        return true;
      }
    };
    exports2.AppImageUpdater = AppImageUpdater;
  }
});

// node_modules/.pnpm/electron-updater@6.8.9/node_modules/electron-updater/out/LinuxUpdater.js
var require_LinuxUpdater = __commonJS({
  "node_modules/.pnpm/electron-updater@6.8.9/node_modules/electron-updater/out/LinuxUpdater.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.LinuxUpdater = void 0;
    var BaseUpdater_12 = require_BaseUpdater();
    var SAFE_PM_REGEX = /^[a-zA-Z0-9_-]+$/;
    var LinuxUpdater = class extends BaseUpdater_12.BaseUpdater {
      constructor(options, app) {
        super(options, app);
      }
      /**
       * Returns true if the current process is running as root.
       */
      isRunningAsRoot() {
        var _a;
        return ((_a = process.getuid) === null || _a === void 0 ? void 0 : _a.call(process)) === 0;
      }
      /**
       * Sanitizes the installer path for use with shell:true spawn calls.
       * Backslash-escapes metacharacters that have special meaning in POSIX shell.
       * Note: paths containing single-quotes (') are not supported.
       */
      get installerPath() {
        const raw = super.installerPath;
        if (raw == null) {
          return null;
        }
        return raw.replace(/\\/g, "\\\\").replace(/([`$!" ;|&()<>])/g, "\\$1").replace(/[\n\r]/g, "");
      }
      runCommandWithSudoIfNeeded(commandWithArgs) {
        if (this.isRunningAsRoot()) {
          this._logger.info("Running as root, no need to use sudo");
          return this.spawnSyncLog(commandWithArgs[0], commandWithArgs.slice(1));
        }
        const { name } = this.app;
        const safeName = name.replace(/["`$\\!\n\r;|&<>(){}*?[\]#~]/g, "");
        const installComment = `"${safeName} would like to update"`;
        const sudo = this.sudoWithArgs(installComment);
        this._logger.info(`Running as non-root user, using sudo to install: ${sudo}`);
        let wrapper = `"`;
        if (/pkexec/i.test(sudo[0]) || sudo[0] === "sudo") {
          wrapper = "";
        }
        return this.spawnSyncLog(sudo[0], [...sudo.length > 1 ? sudo.slice(1) : [], `${wrapper}/bin/bash`, "-c", `'${commandWithArgs.join(" ")}'${wrapper}`]);
      }
      sudoWithArgs(installComment) {
        const sudo = this.determineSudoCommand();
        const command = [sudo];
        if (/kdesudo/i.test(sudo)) {
          command.push("--comment", installComment);
          command.push("-c");
        } else if (/gksudo/i.test(sudo)) {
          command.push("--message", installComment);
        } else if (/pkexec/i.test(sudo)) {
          command.push("--disable-internal-agent");
        }
        return command;
      }
      hasCommand(cmd) {
        try {
          this.spawnSyncLog(`command`, ["-v", cmd]);
          return true;
        } catch {
          return false;
        }
      }
      determineSudoCommand() {
        const sudos = ["gksudo", "kdesudo", "pkexec", "beesu"];
        for (const sudo of sudos) {
          if (this.hasCommand(sudo)) {
            return sudo;
          }
        }
        return "sudo";
      }
      /**
       * Detects the package manager to use based on the available commands.
       * Allows overriding the default behavior by setting the ELECTRON_BUILDER_LINUX_PACKAGE_MANAGER environment variable.
       * If the environment variable is set, it will be used directly. (This is useful for testing each package manager logic path.)
       * Otherwise, it checks for the presence of the specified package manager commands in the order provided.
       * @param pms - An array of package manager commands to check for, in priority order.
       * @returns The detected package manager command or "unknown" if none are found.
       */
      detectPackageManager(pms) {
        var _a;
        let availablePMs = pms;
        const pmOverride = (_a = process.env.ELECTRON_BUILDER_LINUX_PACKAGE_MANAGER) === null || _a === void 0 ? void 0 : _a.trim();
        if (pmOverride) {
          if (!SAFE_PM_REGEX.test(pmOverride)) {
            this._logger.warn(`ELECTRON_BUILDER_LINUX_PACKAGE_MANAGER "${pmOverride}" contains unsafe characters. Ignoring override.`);
          } else {
            availablePMs = [pmOverride];
          }
        }
        for (const pm of availablePMs) {
          if (this.hasCommand(pm)) {
            return pm;
          }
        }
        const searchList = pmOverride ? `ELECTRON_BUILDER_LINUX_PACKAGE_MANAGER override "${pmOverride}", ` : "";
        const defaultPM = pms[0];
        this._logger.warn(`No package manager found in the list: ${searchList}${pms.join(", ")}. Utilizing default: ${defaultPM}`);
        return defaultPM;
      }
    };
    exports2.LinuxUpdater = LinuxUpdater;
  }
});

// node_modules/.pnpm/electron-updater@6.8.9/node_modules/electron-updater/out/DebUpdater.js
var require_DebUpdater = __commonJS({
  "node_modules/.pnpm/electron-updater@6.8.9/node_modules/electron-updater/out/DebUpdater.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.DebUpdater = void 0;
    var Provider_12 = require_Provider();
    var types_1 = require_types();
    var LinuxUpdater_1 = require_LinuxUpdater();
    var DebUpdater = class _DebUpdater extends LinuxUpdater_1.LinuxUpdater {
      constructor(options, app) {
        super(options, app);
      }
      /*** @private */
      doDownloadUpdate(downloadUpdateOptions) {
        const provider = downloadUpdateOptions.updateInfoAndProvider.provider;
        const fileInfo = (0, Provider_12.findFile)(provider.resolveFiles(downloadUpdateOptions.updateInfoAndProvider.info), "deb", ["AppImage", "rpm", "pacman"]);
        return this.executeDownload({
          fileExtension: "deb",
          fileInfo,
          downloadUpdateOptions,
          task: async (updateFile, downloadOptions) => {
            if (this.listenerCount(types_1.DOWNLOAD_PROGRESS) > 0) {
              downloadOptions.onProgress = (it) => this.emit(types_1.DOWNLOAD_PROGRESS, it);
            }
            await this.httpExecutor.download(fileInfo.url, updateFile, downloadOptions);
          }
        });
      }
      doInstall(options) {
        const installerPath = this.installerPath;
        if (installerPath == null) {
          this.dispatchError(new Error("No update filepath provided, can't quit and install"));
          return false;
        }
        if (!this.hasCommand("dpkg") && !this.hasCommand("apt")) {
          this.dispatchError(new Error("Neither dpkg nor apt command found. Cannot install .deb package."));
          return false;
        }
        const priorityList = ["dpkg", "apt"];
        const packageManager = this.detectPackageManager(priorityList);
        try {
          _DebUpdater.installWithCommandRunner(packageManager, installerPath, this.runCommandWithSudoIfNeeded.bind(this), this._logger);
        } catch (error) {
          this.dispatchError(error);
          return false;
        }
        if (options.isForceRunAfter) {
          this.app.relaunch();
        }
        return true;
      }
      static installWithCommandRunner(packageManager, installerPath, commandRunner, logger) {
        var _a;
        if (packageManager === "dpkg") {
          try {
            commandRunner(["dpkg", "-i", installerPath]);
          } catch (error) {
            logger.warn((_a = error.message) !== null && _a !== void 0 ? _a : error);
            logger.warn("dpkg installation failed, trying to fix broken dependencies with apt-get");
            commandRunner(["apt-get", "install", "-f", "-y"]);
          }
        } else if (packageManager === "apt") {
          logger.warn("Using apt to install a local .deb. This may fail for unsigned packages unless properly configured.");
          commandRunner([
            "apt",
            "install",
            "-y",
            "--allow-unauthenticated",
            // needed for unsigned .debs
            "--allow-downgrades",
            // allow lower version installs
            "--allow-change-held-packages",
            installerPath
          ]);
        } else {
          throw new Error(`Package manager ${packageManager} not supported`);
        }
      }
    };
    exports2.DebUpdater = DebUpdater;
  }
});

// node_modules/.pnpm/electron-updater@6.8.9/node_modules/electron-updater/out/PacmanUpdater.js
var require_PacmanUpdater = __commonJS({
  "node_modules/.pnpm/electron-updater@6.8.9/node_modules/electron-updater/out/PacmanUpdater.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.PacmanUpdater = void 0;
    var types_1 = require_types();
    var Provider_12 = require_Provider();
    var LinuxUpdater_1 = require_LinuxUpdater();
    var PacmanUpdater = class _PacmanUpdater extends LinuxUpdater_1.LinuxUpdater {
      constructor(options, app) {
        super(options, app);
      }
      /*** @private */
      doDownloadUpdate(downloadUpdateOptions) {
        const provider = downloadUpdateOptions.updateInfoAndProvider.provider;
        const fileInfo = (0, Provider_12.findFile)(provider.resolveFiles(downloadUpdateOptions.updateInfoAndProvider.info), "pacman", ["AppImage", "deb", "rpm"]);
        return this.executeDownload({
          fileExtension: "pacman",
          fileInfo,
          downloadUpdateOptions,
          task: async (updateFile, downloadOptions) => {
            if (this.listenerCount(types_1.DOWNLOAD_PROGRESS) > 0) {
              downloadOptions.onProgress = (it) => this.emit(types_1.DOWNLOAD_PROGRESS, it);
            }
            await this.httpExecutor.download(fileInfo.url, updateFile, downloadOptions);
          }
        });
      }
      doInstall(options) {
        const installerPath = this.installerPath;
        if (installerPath == null) {
          this.dispatchError(new Error("No update filepath provided, can't quit and install"));
          return false;
        }
        try {
          _PacmanUpdater.installWithCommandRunner(installerPath, this.runCommandWithSudoIfNeeded.bind(this), this._logger);
        } catch (error) {
          this.dispatchError(error);
          return false;
        }
        if (options.isForceRunAfter) {
          this.app.relaunch();
        }
        return true;
      }
      static installWithCommandRunner(installerPath, commandRunner, logger) {
        var _a;
        try {
          commandRunner(["pacman", "-U", "--noconfirm", installerPath]);
        } catch (error) {
          logger.warn((_a = error.message) !== null && _a !== void 0 ? _a : error);
          logger.warn("pacman installation failed, attempting to update package database and retry");
          try {
            commandRunner(["pacman", "-Sy", "--noconfirm"]);
            commandRunner(["pacman", "-U", "--noconfirm", installerPath]);
          } catch (retryError) {
            logger.error("Retry after pacman -Sy failed");
            throw retryError;
          }
        }
      }
    };
    exports2.PacmanUpdater = PacmanUpdater;
  }
});

// node_modules/.pnpm/electron-updater@6.8.9/node_modules/electron-updater/out/RpmUpdater.js
var require_RpmUpdater = __commonJS({
  "node_modules/.pnpm/electron-updater@6.8.9/node_modules/electron-updater/out/RpmUpdater.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.RpmUpdater = void 0;
    var types_1 = require_types();
    var Provider_12 = require_Provider();
    var LinuxUpdater_1 = require_LinuxUpdater();
    var RpmUpdater = class _RpmUpdater extends LinuxUpdater_1.LinuxUpdater {
      constructor(options, app) {
        super(options, app);
      }
      /*** @private */
      doDownloadUpdate(downloadUpdateOptions) {
        const provider = downloadUpdateOptions.updateInfoAndProvider.provider;
        const fileInfo = (0, Provider_12.findFile)(provider.resolveFiles(downloadUpdateOptions.updateInfoAndProvider.info), "rpm", ["AppImage", "deb", "pacman"]);
        return this.executeDownload({
          fileExtension: "rpm",
          fileInfo,
          downloadUpdateOptions,
          task: async (updateFile, downloadOptions) => {
            if (this.listenerCount(types_1.DOWNLOAD_PROGRESS) > 0) {
              downloadOptions.onProgress = (it) => this.emit(types_1.DOWNLOAD_PROGRESS, it);
            }
            await this.httpExecutor.download(fileInfo.url, updateFile, downloadOptions);
          }
        });
      }
      doInstall(options) {
        const installerPath = this.installerPath;
        if (installerPath == null) {
          this.dispatchError(new Error("No update filepath provided, can't quit and install"));
          return false;
        }
        const priorityList = ["zypper", "dnf", "yum", "rpm"];
        const packageManager = this.detectPackageManager(priorityList);
        try {
          _RpmUpdater.installWithCommandRunner(packageManager, installerPath, this.runCommandWithSudoIfNeeded.bind(this), this._logger);
        } catch (error) {
          this.dispatchError(error);
          return false;
        }
        if (options.isForceRunAfter) {
          this.app.relaunch();
        }
        return true;
      }
      static installWithCommandRunner(packageManager, installerPath, commandRunner, logger) {
        if (packageManager === "zypper") {
          return commandRunner(["zypper", "--non-interactive", "--no-refresh", "install", "--allow-unsigned-rpm", "-f", installerPath]);
        }
        if (packageManager === "dnf") {
          return commandRunner(["dnf", "install", "--nogpgcheck", "-y", installerPath]);
        }
        if (packageManager === "yum") {
          return commandRunner(["yum", "install", "--nogpgcheck", "-y", installerPath]);
        }
        if (packageManager === "rpm") {
          logger.warn("Installing with rpm only (no dependency resolution).");
          return commandRunner(["rpm", "-Uvh", "--replacepkgs", "--replacefiles", "--nodeps", installerPath]);
        }
        throw new Error(`Package manager ${packageManager} not supported`);
      }
    };
    exports2.RpmUpdater = RpmUpdater;
  }
});

// node_modules/.pnpm/electron-updater@6.8.9/node_modules/electron-updater/out/MacUpdater.js
var require_MacUpdater = __commonJS({
  "node_modules/.pnpm/electron-updater@6.8.9/node_modules/electron-updater/out/MacUpdater.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.MacUpdater = void 0;
    var builder_util_runtime_1 = require_out();
    var fs_extra_12 = require_lib();
    var fs_1 = require("fs");
    var path2 = require("path");
    var http_1 = require("http");
    var AppUpdater_12 = require_AppUpdater();
    var Provider_12 = require_Provider();
    var child_process_1 = require("child_process");
    var crypto_1 = require("crypto");
    var MacUpdater = class _MacUpdater extends AppUpdater_12.AppUpdater {
      constructor(options, app) {
        super(options, app);
        this.nativeUpdater = require("electron").autoUpdater;
        this.squirrelDownloadedUpdate = false;
        this.nativeUpdater.on("error", (it) => {
          this._logger.warn(it);
          this.emit("error", it);
        });
        this.nativeUpdater.on("update-downloaded", () => {
          this.squirrelDownloadedUpdate = true;
          this.debug("nativeUpdater.update-downloaded");
        });
      }
      /** Filters update files to the appropriate architecture.
       * On arm64 Macs (including Rosetta), arm64 files are preferred when available.
       * On x64 Macs, arm64 files are excluded. */
      static filterFilesForArch(files, isArm64Mac) {
        const isArm64File = (file) => {
          var _a;
          return file.url.pathname.includes("arm64") || ((_a = file.info.url) === null || _a === void 0 ? void 0 : _a.includes("arm64"));
        };
        if (isArm64Mac && files.some(isArm64File)) {
          return files.filter((file) => isArm64Mac === isArm64File(file));
        }
        return files.filter((file) => !isArm64File(file));
      }
      debug(message) {
        if (this._logger.debug != null) {
          this._logger.debug(message);
        }
      }
      closeServerIfExists() {
        if (this.server) {
          this.debug("Closing proxy server");
          this.server.close((err) => {
            if (err) {
              this.debug("proxy server wasn't already open, probably attempted closing again as a safety check before quit");
            }
          });
        }
      }
      async doDownloadUpdate(downloadUpdateOptions) {
        let files = downloadUpdateOptions.updateInfoAndProvider.provider.resolveFiles(downloadUpdateOptions.updateInfoAndProvider.info);
        const log = this._logger;
        const sysctlRosettaInfoKey = "sysctl.proc_translated";
        let isRosetta = false;
        try {
          this.debug("Checking for macOS Rosetta environment");
          const result = (0, child_process_1.execFileSync)("sysctl", [sysctlRosettaInfoKey], { encoding: "utf8" });
          isRosetta = result.includes(`${sysctlRosettaInfoKey}: 1`);
          log.info(`Checked for macOS Rosetta environment (isRosetta=${isRosetta})`);
        } catch (e) {
          log.warn(`sysctl shell command to check for macOS Rosetta environment failed: ${e}`);
        }
        let isArm64Mac = false;
        try {
          this.debug("Checking for arm64 in uname");
          const result = (0, child_process_1.execFileSync)("uname", ["-a"], { encoding: "utf8" });
          const isArm = result.includes("ARM");
          log.info(`Checked 'uname -a': arm64=${isArm}`);
          isArm64Mac = isArm64Mac || isArm;
        } catch (e) {
          log.warn(`uname shell command to check for arm64 failed: ${e}`);
        }
        isArm64Mac = isArm64Mac || process.arch === "arm64" || isRosetta;
        files = _MacUpdater.filterFilesForArch(files, isArm64Mac);
        const zipFileInfo = (0, Provider_12.findFile)(files, "zip", ["pkg", "dmg"]);
        if (zipFileInfo == null) {
          throw (0, builder_util_runtime_1.newError)(`ZIP file not provided: ${(0, builder_util_runtime_1.safeStringifyJson)(files)}`, "ERR_UPDATER_ZIP_FILE_NOT_FOUND");
        }
        const provider = downloadUpdateOptions.updateInfoAndProvider.provider;
        const CURRENT_MAC_APP_ZIP_FILE_NAME = "update.zip";
        return this.executeDownload({
          fileExtension: "zip",
          fileInfo: zipFileInfo,
          downloadUpdateOptions,
          task: async (destinationFile, downloadOptions) => {
            const cachedUpdateFilePath = path2.join(this.downloadedUpdateHelper.cacheDir, CURRENT_MAC_APP_ZIP_FILE_NAME);
            const canDifferentialDownload = () => {
              if (!(0, fs_extra_12.pathExistsSync)(cachedUpdateFilePath)) {
                log.info("Unable to locate previous update.zip for differential download (is this first install?), falling back to full download");
                return false;
              }
              return !downloadUpdateOptions.disableDifferentialDownload;
            };
            let differentialDownloadFailed = true;
            if (canDifferentialDownload()) {
              differentialDownloadFailed = await this.differentialDownloadInstaller(zipFileInfo, downloadUpdateOptions, destinationFile, provider, CURRENT_MAC_APP_ZIP_FILE_NAME);
            }
            if (differentialDownloadFailed) {
              await this.httpExecutor.download(zipFileInfo.url, destinationFile, downloadOptions);
            }
          },
          done: async (event) => {
            if (!downloadUpdateOptions.disableDifferentialDownload) {
              try {
                const cachedUpdateFilePath = path2.join(this.downloadedUpdateHelper.cacheDir, CURRENT_MAC_APP_ZIP_FILE_NAME);
                await (0, fs_extra_12.copyFile)(event.downloadedFile, cachedUpdateFilePath);
              } catch (error) {
                this._logger.warn(`Unable to copy file for caching for future differential downloads: ${error.message}`);
              }
            }
            return this.updateDownloaded(zipFileInfo, event);
          }
        });
      }
      async updateDownloaded(zipFileInfo, event) {
        var _a;
        const downloadedFile = event.downloadedFile;
        const updateFileSize = (_a = zipFileInfo.info.size) !== null && _a !== void 0 ? _a : (await (0, fs_extra_12.stat)(downloadedFile)).size;
        const log = this._logger;
        const logContext = `fileToProxy=${zipFileInfo.url.href}`;
        this.closeServerIfExists();
        this.debug(`Creating proxy server for native Squirrel.Mac (${logContext})`);
        this.server = (0, http_1.createServer)();
        this.debug(`Proxy server for native Squirrel.Mac is created (${logContext})`);
        this.server.on("close", () => {
          log.info(`Proxy server for native Squirrel.Mac is closed (${logContext})`);
        });
        const getServerUrl = (s) => {
          const address = s.address();
          if (typeof address === "string") {
            return address;
          }
          return `http://127.0.0.1:${address === null || address === void 0 ? void 0 : address.port}`;
        };
        return await new Promise((resolve, reject) => {
          const pass = (0, crypto_1.randomBytes)(64).toString("base64").replace(/\//g, "_").replace(/\+/g, "-");
          const authInfo = Buffer.from(`autoupdater:${pass}`, "ascii");
          const fileUrl = `/${(0, crypto_1.randomBytes)(64).toString("hex")}.zip`;
          this.server.on("request", (request, response) => {
            const requestUrl = request.url;
            log.info(`${requestUrl} requested`);
            if (requestUrl === "/") {
              if (!request.headers.authorization || request.headers.authorization.indexOf("Basic ") === -1) {
                response.statusCode = 401;
                response.statusMessage = "Invalid Authentication Credentials";
                response.end();
                log.warn("No authenthication info");
                return;
              }
              const base64Credentials = request.headers.authorization.split(" ")[1];
              const credentials = Buffer.from(base64Credentials, "base64").toString("ascii");
              const [username, password] = credentials.split(":");
              if (username !== "autoupdater" || password !== pass) {
                response.statusCode = 401;
                response.statusMessage = "Invalid Authentication Credentials";
                response.end();
                log.warn("Invalid authenthication credentials");
                return;
              }
              const data = Buffer.from(`{ "url": "${getServerUrl(this.server)}${fileUrl}" }`);
              response.writeHead(200, { "Content-Type": "application/json", "Content-Length": data.length });
              response.end(data);
              return;
            }
            if (!requestUrl.startsWith(fileUrl)) {
              log.warn(`${requestUrl} requested, but not supported`);
              response.writeHead(404);
              response.end();
              return;
            }
            log.info(`${fileUrl} requested by Squirrel.Mac, pipe ${downloadedFile}`);
            let errorOccurred = false;
            response.on("finish", () => {
              if (!errorOccurred) {
                this.nativeUpdater.removeListener("error", reject);
                resolve([]);
              }
            });
            const readStream = (0, fs_1.createReadStream)(downloadedFile);
            readStream.on("error", (error) => {
              try {
                response.end();
              } catch (e) {
                log.warn(`cannot end response: ${e}`);
              }
              errorOccurred = true;
              this.nativeUpdater.removeListener("error", reject);
              reject(new Error(`Cannot pipe "${downloadedFile}": ${error}`));
            });
            response.writeHead(200, {
              "Content-Type": "application/zip",
              "Content-Length": updateFileSize
            });
            readStream.pipe(response);
          });
          this.debug(`Proxy server for native Squirrel.Mac is starting to listen (${logContext})`);
          this.server.listen(0, "127.0.0.1", () => {
            this.debug(`Proxy server for native Squirrel.Mac is listening (address=${getServerUrl(this.server)}, ${logContext})`);
            this.nativeUpdater.setFeedURL({
              url: getServerUrl(this.server),
              headers: {
                "Cache-Control": "no-cache",
                Authorization: `Basic ${authInfo.toString("base64")}`
              }
            });
            this.dispatchUpdateDownloaded(event);
            if (this.autoInstallOnAppQuit) {
              this.nativeUpdater.once("error", reject);
              this.nativeUpdater.checkForUpdates();
            } else {
              resolve([]);
            }
          });
        });
      }
      handleUpdateDownloaded() {
        if (this.autoRunAppAfterInstall) {
          this.nativeUpdater.quitAndInstall();
        } else {
          this.app.quit();
        }
        this.closeServerIfExists();
      }
      quitAndInstall() {
        if (this.squirrelDownloadedUpdate) {
          this.handleUpdateDownloaded();
        } else {
          this.nativeUpdater.on("update-downloaded", () => this.handleUpdateDownloaded());
          if (!this.autoInstallOnAppQuit) {
            this.nativeUpdater.checkForUpdates();
          }
        }
      }
    };
    exports2.MacUpdater = MacUpdater;
  }
});

// node_modules/.pnpm/electron-updater@6.8.9/node_modules/electron-updater/out/windowsExecutableCodeSignatureVerifier.js
var require_windowsExecutableCodeSignatureVerifier = __commonJS({
  "node_modules/.pnpm/electron-updater@6.8.9/node_modules/electron-updater/out/windowsExecutableCodeSignatureVerifier.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.verifySignature = verifySignature;
    var builder_util_runtime_1 = require_out();
    var child_process_1 = require("child_process");
    var os = require("os");
    var path2 = require("path");
    function preparePowerShellExec(command, timeout) {
      const executable = `set "PSModulePath=" & chcp 65001 >NUL & powershell.exe`;
      const args = ["-NoProfile", "-NonInteractive", "-InputFormat", "None", "-Command", command];
      const options = {
        shell: true,
        timeout
      };
      return [executable, args, options];
    }
    function verifySignature(publisherNames, unescapedTempUpdateFile, logger) {
      return new Promise((resolve, reject) => {
        const tempUpdateFile = unescapedTempUpdateFile.replace(/'/g, "''");
        logger.info(`Verifying signature ${tempUpdateFile}`);
        (0, child_process_1.execFile)(...preparePowerShellExec(`"Get-AuthenticodeSignature -LiteralPath '${tempUpdateFile}' | ConvertTo-Json -Compress"`, 20 * 1e3), (error, stdout, stderr) => {
          var _a;
          try {
            if (error != null || stderr) {
              handleError(logger, error, stderr, reject);
              resolve(null);
              return;
            }
            const data = parseOut(stdout);
            if (data.Status === 0) {
              try {
                const normlaizedUpdateFilePath = path2.normalize(data.Path);
                const normalizedTempUpdateFile = path2.normalize(unescapedTempUpdateFile);
                logger.info(`LiteralPath: ${normlaizedUpdateFilePath}. Update Path: ${normalizedTempUpdateFile}`);
                if (normlaizedUpdateFilePath !== normalizedTempUpdateFile) {
                  handleError(logger, new Error(`LiteralPath of ${normlaizedUpdateFilePath} is different than ${normalizedTempUpdateFile}`), stderr, reject);
                  resolve(null);
                  return;
                }
              } catch (error2) {
                logger.warn(`Unable to verify LiteralPath of update asset due to missing data.Path. Skipping this step of validation. Message: ${(_a = error2.message) !== null && _a !== void 0 ? _a : error2.stack}`);
              }
              const subject = (0, builder_util_runtime_1.parseDn)(data.SignerCertificate.Subject);
              let match = false;
              for (const name of publisherNames) {
                const dn = (0, builder_util_runtime_1.parseDn)(name);
                if (dn.size) {
                  const allKeys = Array.from(dn.keys());
                  match = allKeys.every((key) => {
                    return dn.get(key) === subject.get(key);
                  });
                } else if (name === subject.get("CN")) {
                  logger.warn(`Signature validated using only CN ${name}. Please add your full Distinguished Name (DN) to publisherNames configuration`);
                  match = true;
                }
                if (match) {
                  resolve(null);
                  return;
                }
              }
            }
            const result = `publisherNames: ${publisherNames.join(" | ")}, raw info: ` + JSON.stringify(data, (name, value) => name === "RawData" ? void 0 : value, 2);
            logger.warn(`Sign verification failed, installer signed with incorrect certificate: ${result}`);
            resolve(result);
          } catch (e) {
            handleError(logger, e, null, reject);
            resolve(null);
            return;
          }
        });
      });
    }
    function parseOut(out) {
      const data = JSON.parse(out);
      delete data.PrivateKey;
      delete data.IsOSBinary;
      delete data.SignatureType;
      const signerCertificate = data.SignerCertificate;
      if (signerCertificate != null) {
        delete signerCertificate.Archived;
        delete signerCertificate.Extensions;
        delete signerCertificate.Handle;
        delete signerCertificate.HasPrivateKey;
        delete signerCertificate.SubjectName;
      }
      return data;
    }
    function handleError(logger, error, stderr, reject) {
      if (isOldWin6()) {
        logger.warn(`Cannot execute Get-AuthenticodeSignature: ${error || stderr}. Ignoring signature validation due to unsupported powershell version. Please upgrade to powershell 3 or higher.`);
        return;
      }
      try {
        (0, child_process_1.execFileSync)(...preparePowerShellExec("ConvertTo-Json test", 10 * 1e3));
      } catch (testError) {
        logger.warn(`Cannot execute ConvertTo-Json: ${testError.message}. Ignoring signature validation due to unsupported powershell version. Please upgrade to powershell 3 or higher.`);
        return;
      }
      if (error != null) {
        reject(error);
      }
      if (stderr) {
        reject(new Error(`Cannot execute Get-AuthenticodeSignature, stderr: ${stderr}. Failing signature validation due to unknown stderr.`));
      }
    }
    function isOldWin6() {
      const winVersion = os.release();
      return winVersion.startsWith("6.") && !winVersion.startsWith("6.3");
    }
  }
});

// node_modules/.pnpm/electron-updater@6.8.9/node_modules/electron-updater/out/NsisUpdater.js
var require_NsisUpdater = __commonJS({
  "node_modules/.pnpm/electron-updater@6.8.9/node_modules/electron-updater/out/NsisUpdater.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.NsisUpdater = void 0;
    var builder_util_runtime_1 = require_out();
    var path2 = require("path");
    var BaseUpdater_12 = require_BaseUpdater();
    var FileWithEmbeddedBlockMapDifferentialDownloader_1 = require_FileWithEmbeddedBlockMapDifferentialDownloader();
    var types_1 = require_types();
    var Provider_12 = require_Provider();
    var fs_extra_12 = require_lib();
    var windowsExecutableCodeSignatureVerifier_1 = require_windowsExecutableCodeSignatureVerifier();
    var url_1 = require("url");
    var NsisUpdater = class extends BaseUpdater_12.BaseUpdater {
      constructor(options, app) {
        super(options, app);
        this._verifyUpdateCodeSignature = (publisherNames, unescapedTempUpdateFile) => (0, windowsExecutableCodeSignatureVerifier_1.verifySignature)(publisherNames, unescapedTempUpdateFile, this._logger);
      }
      /**
       * The verifyUpdateCodeSignature. You can pass [win-verify-signature](https://github.com/beyondkmp/win-verify-trust) or another custom verify function: ` (publisherName: string[], path: string) => Promise<string | null>`.
       * The default verify function uses [windowsExecutableCodeSignatureVerifier](https://github.com/electron-userland/electron-builder/blob/master/packages/electron-updater/src/windowsExecutableCodeSignatureVerifier.ts)
       */
      get verifyUpdateCodeSignature() {
        return this._verifyUpdateCodeSignature;
      }
      set verifyUpdateCodeSignature(value) {
        if (value) {
          this._verifyUpdateCodeSignature = value;
        }
      }
      /*** @private */
      doDownloadUpdate(downloadUpdateOptions) {
        const provider = downloadUpdateOptions.updateInfoAndProvider.provider;
        const fileInfo = (0, Provider_12.findFile)(provider.resolveFiles(downloadUpdateOptions.updateInfoAndProvider.info), "exe");
        return this.executeDownload({
          fileExtension: "exe",
          downloadUpdateOptions,
          fileInfo,
          task: async (destinationFile, downloadOptions, packageFile, removeTempDirIfAny) => {
            const packageInfo = fileInfo.packageInfo;
            const isWebInstaller = packageInfo != null && packageFile != null;
            if (isWebInstaller && downloadUpdateOptions.disableWebInstaller) {
              throw (0, builder_util_runtime_1.newError)(`Unable to download new version ${downloadUpdateOptions.updateInfoAndProvider.info.version}. Web Installers are disabled`, "ERR_UPDATER_WEB_INSTALLER_DISABLED");
            }
            if (!isWebInstaller && !downloadUpdateOptions.disableWebInstaller) {
              this._logger.warn("disableWebInstaller is set to false, you should set it to true if you do not plan on using a web installer. This will default to true in a future version.");
            }
            if (isWebInstaller || downloadUpdateOptions.disableDifferentialDownload || await this.differentialDownloadInstaller(fileInfo, downloadUpdateOptions, destinationFile, provider, builder_util_runtime_1.CURRENT_APP_INSTALLER_FILE_NAME)) {
              await this.httpExecutor.download(fileInfo.url, destinationFile, downloadOptions);
            }
            const signatureVerificationStatus = await this.verifySignature(destinationFile);
            if (signatureVerificationStatus != null) {
              await removeTempDirIfAny();
              throw (0, builder_util_runtime_1.newError)(`New version ${downloadUpdateOptions.updateInfoAndProvider.info.version} is not signed by the application owner: ${signatureVerificationStatus}`, "ERR_UPDATER_INVALID_SIGNATURE");
            }
            if (isWebInstaller) {
              if (await this.differentialDownloadWebPackage(downloadUpdateOptions, packageInfo, packageFile, provider)) {
                try {
                  await this.httpExecutor.download(new url_1.URL(packageInfo.path), packageFile, {
                    headers: downloadUpdateOptions.requestHeaders,
                    cancellationToken: downloadUpdateOptions.cancellationToken,
                    sha512: packageInfo.sha512
                  });
                } catch (e) {
                  try {
                    await (0, fs_extra_12.unlink)(packageFile);
                  } catch (_ignored) {
                  }
                  throw e;
                }
              }
            }
          }
        });
      }
      // $certificateInfo = (Get-AuthenticodeSignature 'xxx\yyy.exe'
      // | where {$_.Status.Equals([System.Management.Automation.SignatureStatus]::Valid) -and $_.SignerCertificate.Subject.Contains("CN=siemens.com")})
      // | Out-String ; if ($certificateInfo) { exit 0 } else { exit 1 }
      async verifySignature(tempUpdateFile) {
        let publisherName;
        try {
          publisherName = (await this.configOnDisk.value).publisherName;
          if (publisherName == null) {
            return null;
          }
        } catch (e) {
          if (e.code === "ENOENT") {
            return null;
          }
          throw e;
        }
        return await this._verifyUpdateCodeSignature(Array.isArray(publisherName) ? publisherName : [publisherName], tempUpdateFile);
      }
      doInstall(options) {
        const installerPath = this.installerPath;
        if (installerPath == null) {
          this.dispatchError(new Error("No update filepath provided, can't quit and install"));
          return false;
        }
        const args = ["--updated"];
        if (options.isSilent) {
          args.push("/S");
        }
        if (options.isForceRunAfter) {
          args.push("--force-run");
        }
        if (this.installDirectory) {
          args.push(`/D=${this.installDirectory}`);
        }
        const packagePath = this.downloadedUpdateHelper == null ? null : this.downloadedUpdateHelper.packageFile;
        if (packagePath != null) {
          args.push(`--package-file=${packagePath}`);
        }
        const callUsingElevation = () => {
          this.spawnLog(path2.join(process.resourcesPath, "elevate.exe"), [installerPath].concat(args)).catch((e) => this.dispatchError(e));
        };
        if (options.isAdminRightsRequired) {
          this._logger.info("isAdminRightsRequired is set to true, run installer using elevate.exe");
          callUsingElevation();
          return true;
        }
        this.spawnLog(installerPath, args).catch((e) => {
          const errorCode = e.code;
          this._logger.info(`Cannot run installer: error code: ${errorCode}, error message: "${e.message}", will be executed again using elevate if EACCES, and will try to use electron.shell.openItem if ENOENT`);
          if (errorCode === "UNKNOWN" || errorCode === "EACCES") {
            callUsingElevation();
          } else if (errorCode === "ENOENT") {
            require("electron").shell.openPath(installerPath).catch((err) => this.dispatchError(err));
          } else {
            this.dispatchError(e);
          }
        });
        return true;
      }
      async differentialDownloadWebPackage(downloadUpdateOptions, packageInfo, packagePath, provider) {
        if (packageInfo.blockMapSize == null) {
          return true;
        }
        try {
          const downloadOptions = {
            newUrl: new url_1.URL(packageInfo.path),
            oldFile: path2.join(this.downloadedUpdateHelper.cacheDir, builder_util_runtime_1.CURRENT_APP_PACKAGE_FILE_NAME),
            logger: this._logger,
            newFile: packagePath,
            requestHeaders: this.requestHeaders,
            isUseMultipleRangeRequest: provider.isUseMultipleRangeRequest,
            cancellationToken: downloadUpdateOptions.cancellationToken
          };
          if (this.listenerCount(types_1.DOWNLOAD_PROGRESS) > 0) {
            downloadOptions.onProgress = (it) => this.emit(types_1.DOWNLOAD_PROGRESS, it);
          }
          await new FileWithEmbeddedBlockMapDifferentialDownloader_1.FileWithEmbeddedBlockMapDifferentialDownloader(packageInfo, this.httpExecutor, downloadOptions).download();
        } catch (e) {
          this._logger.error(`Cannot download differentially, fallback to full download: ${e.stack || e}`);
          return process.platform === "win32";
        }
        return false;
      }
    };
    exports2.NsisUpdater = NsisUpdater;
  }
});

// node_modules/.pnpm/electron-updater@6.8.9/node_modules/electron-updater/out/main.js
var __createBinding = exports && exports.__createBinding || (Object.create ? (function(o, m, k, k2) {
  if (k2 === void 0) k2 = k;
  var desc = Object.getOwnPropertyDescriptor(m, k);
  if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
    desc = { enumerable: true, get: function() {
      return m[k];
    } };
  }
  Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
  if (k2 === void 0) k2 = k;
  o[k2] = m[k];
}));
var __exportStar = exports && exports.__exportStar || function(m, exports2) {
  for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports2, p)) __createBinding(exports2, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.NsisUpdater = exports.MacUpdater = exports.RpmUpdater = exports.PacmanUpdater = exports.DebUpdater = exports.AppImageUpdater = exports.Provider = exports.NoOpLogger = exports.AppUpdater = exports.BaseUpdater = void 0;
var fs_extra_1 = require_lib();
var path = require("path");
var BaseUpdater_1 = require_BaseUpdater();
Object.defineProperty(exports, "BaseUpdater", { enumerable: true, get: function() {
  return BaseUpdater_1.BaseUpdater;
} });
var AppUpdater_1 = require_AppUpdater();
Object.defineProperty(exports, "AppUpdater", { enumerable: true, get: function() {
  return AppUpdater_1.AppUpdater;
} });
Object.defineProperty(exports, "NoOpLogger", { enumerable: true, get: function() {
  return AppUpdater_1.NoOpLogger;
} });
var Provider_1 = require_Provider();
Object.defineProperty(exports, "Provider", { enumerable: true, get: function() {
  return Provider_1.Provider;
} });
var AppImageUpdater_1 = require_AppImageUpdater();
Object.defineProperty(exports, "AppImageUpdater", { enumerable: true, get: function() {
  return AppImageUpdater_1.AppImageUpdater;
} });
var DebUpdater_1 = require_DebUpdater();
Object.defineProperty(exports, "DebUpdater", { enumerable: true, get: function() {
  return DebUpdater_1.DebUpdater;
} });
var PacmanUpdater_1 = require_PacmanUpdater();
Object.defineProperty(exports, "PacmanUpdater", { enumerable: true, get: function() {
  return PacmanUpdater_1.PacmanUpdater;
} });
var RpmUpdater_1 = require_RpmUpdater();
Object.defineProperty(exports, "RpmUpdater", { enumerable: true, get: function() {
  return RpmUpdater_1.RpmUpdater;
} });
var MacUpdater_1 = require_MacUpdater();
Object.defineProperty(exports, "MacUpdater", { enumerable: true, get: function() {
  return MacUpdater_1.MacUpdater;
} });
var NsisUpdater_1 = require_NsisUpdater();
Object.defineProperty(exports, "NsisUpdater", { enumerable: true, get: function() {
  return NsisUpdater_1.NsisUpdater;
} });
__exportStar(require_types(), exports);
var _autoUpdater;
function doLoadAutoUpdater() {
  if (process.platform === "win32") {
    _autoUpdater = new (require_NsisUpdater()).NsisUpdater();
  } else if (process.platform === "darwin") {
    _autoUpdater = new (require_MacUpdater()).MacUpdater();
  } else {
    _autoUpdater = new (require_AppImageUpdater()).AppImageUpdater();
    try {
      const identity = path.join(process.resourcesPath, "package-type");
      if (!(0, fs_extra_1.existsSync)(identity)) {
        return _autoUpdater;
      }
      const fileType = (0, fs_extra_1.readFileSync)(identity).toString().trim();
      switch (fileType) {
        case "deb":
          _autoUpdater = new (require_DebUpdater()).DebUpdater();
          break;
        case "rpm":
          _autoUpdater = new (require_RpmUpdater()).RpmUpdater();
          break;
        case "pacman":
          _autoUpdater = new (require_PacmanUpdater()).PacmanUpdater();
          break;
        default:
          break;
      }
    } catch (error) {
      console.warn("Unable to detect 'package-type' for autoUpdater (rpm/deb/pacman support). If you'd like to expand support, please consider contributing to electron-builder", error.message);
    }
  }
  return _autoUpdater;
}
Object.defineProperty(exports, "autoUpdater", {
  enumerable: true,
  get: () => {
    return _autoUpdater || doLoadAutoUpdater();
  }
});
/*! Bundled license information:

sax/lib/sax.js:
  (*! http://mths.be/fromcodepoint v0.1.0 by @mathias *)

js-yaml/dist/js-yaml.cjs.js:
  (*! js-yaml 5.4.1 https://github.com/nodeca/js-yaml @license MIT *)
*/
