const after  = require('after')
    , xtend  = require('xtend')
    , spaces = require('level-spaces')

    , DEFAULT_FREQUENCY = 10000


function startTtl (db, checkFrequency) {
  db._ttl.intervalId = setInterval(function () {
    var batch    = []
      , subBatch = []
      , query = {
            keyEncoding: 'utf8'
          , valueEncoding: 'utf8'
          , end: String(Date.now())
        }

    db._ttl._checkInProgress = true
    db._ttl.sub.createReadStream(query)
      .on('data', function (data) {
        subBatch.push({ type: 'del', key: data.value })
        subBatch.push({ type: 'del', key: data.key })
        batch.push({ type: 'del', key: data.value })
      })
      .on('error', db.emit.bind(db, 'error'))
      .on('end', function () {
        if (batch.length) {
          db._ttl.sub.batch(
              subBatch
            , { keyEncoding: 'utf8' }
            , function (err) {
                if (err)
                  db.emit('error', err)
              }
          )
          db._ttl.batch(
              batch
            , { keyEncoding: 'utf8' }
            , function (err) {
                if (err)
                  db.emit('error', err)
              }
          )
        }
      })
      .on('close', function () {
        db._ttl._checkInProgress = false
        if (db._ttl._stopAfterCheck) {
          stopTtl(db, db._ttl._stopAfterCheck)
          db._ttl._stopAfterCheck = null
        }
      })
  }, checkFrequency)
  if (db._ttl.intervalId.unref)
    db._ttl.intervalId.unref()
}

function stopTtl (db, callback) {
  // can't close a db while an interator is in progress
  // so if one is, defer
  if (db._ttl._checkInProgress)
    return db._ttl._stopAfterCheck = callback
  clearInterval(db._ttl.intervalId)
  callback && callback()
}

function ttlon (db, keys, ttl, callback) {
  var exp   = String(Date.now() + ttl)
    , batch = []

  if (!Array.isArray(keys))
    keys = [ keys ]

  ttloff(db, keys, function () {
    keys.forEach(function (key) {
      if (typeof key != 'string')
        key = key.toString()
      batch.push({ type: 'put', key: key               , value: exp })
      batch.push({ type: 'put', key: exp + '!' + key, value: key })
    })

    if (!batch.length)
      return callback && callback()

    db._ttl.sub.batch(
        batch
      , { keyEncoding: 'utf8', valueEncoding: 'utf8' }
      , function (err) {
          if (err)
            db.emit('error', err)
          callback && callback()
        }
    )
  })
}

function ttloff (db, keys, callback) {
  if (!Array.isArray(keys))
    keys = [ keys ]

  var batch = []
    , done  = after(keys.length, function (err) {
        if (err)
          db.emit('error', err)

        if (!batch.length)
          return callback && callback()

        db._ttl.sub.batch(
            batch
          , { keyEncoding: 'utf8', valueEncoding: 'utf8' }
          , function (err) {
              if (err)
                db.emit('error', err)
              callback && callback()
            }
        )
      })

  keys.forEach(function (key) {
    if (typeof key != 'string')
      key = key.toString()

    db._ttl.sub.get(
        key
      , { keyEncoding: 'utf8', valueEncoding: 'utf8' }
      , function (err, exp) {
          if (!err && exp > 0) {
            batch.push({ type: 'del', key: key })
            batch.push({ type: 'del', key: exp + '!' + key })
          }
          done(err && err.name != 'NotFoundError' && err)
        }
    )
  })
}

function put (db, key, value, options, callback) {
  var ttl
    , done
    , _callback = callback

  if (typeof options == 'object' && (ttl = options.ttl) > 0
      && key !== null && key !== undefined
      && value !== null && value !== undefined) {

    done = after(2, _callback || function () {})
    callback = done
    ttlon(db, key, options.ttl, done)
  }

  db._ttl.put.call(db, key, value, options, callback)
}

function ttl (db, key, _ttl, callback) {
  if (_ttl > 0 && key !== null && key !== undefined)
    ttlon(db, key, _ttl, callback)
}

function del (db, key, options, callback) {
  var done
    , _callback = callback
  if (key !== null && key !== undefined) {
    done = after(2, _callback || function () {})
    callback = done
    ttloff(db, key, done)
  }

  db._ttl.del.call(db, key, options, callback)
}

function batch (db, arr, options, callback) {
  var ttl
    , done
    , on
    , off
    , _callback = callback

  if (typeof options == 'object' && (ttl = options.ttl) > 0 && Array.isArray(arr)) {
    done = after(3, _callback || function () {})
    callback = done

    on  = []
    off = []
    arr.forEach(function (entry) {
      if (!entry || entry.key === null || entry.key === undefined)
        return

      if (entry.type == 'put' && entry.value !== null && entry.value !== undefined)
        on.push(entry.key)
      if (entry.type == 'del')
        off.push(entry.key)
    })

    if (on.length)
      ttlon(db, on, options.ttl, done)
    else
      done()
    if (off.length)
      ttloff(db, off, done)
    else
      done()
  }

  db._ttl.batch.call(db, arr, options, callback)
}

function close (db, callback) {
  stopTtl(db, function () {
    if (db._ttl && typeof db._ttl.close == 'function')
      return db._ttl.close.call(db, callback)
    callback && callback()
  })
}

function setup (db, options) {
  if (db._ttl)
    return

  options = options || {}

  // backwards compatibility
  if (!options.namespace && options.sublevel)
    options.namespace = options.sublevel

  options = xtend({
      methodPrefix   : ''
    , namespace      : 'ttl'
    , checkFrequency : DEFAULT_FREQUENCY
  }, options)

  db._ttl = {
      put   : db.put.bind(db)
    , del   : db.del.bind(db)
    , batch : db.batch.bind(db)
    , close : db.close.bind(db)
    , sub   : spaces(db, options.namespace)
  }

  db[options.methodPrefix + 'put']   = put.bind(null, db)
  db[options.methodPrefix + 'del']   = del.bind(null, db)
  db[options.methodPrefix + 'batch'] = batch.bind(null, db)
  db[options.methodPrefix + 'ttl']   = ttl.bind(null, db)
  db[options.methodPrefix + 'stop']  = stopTtl.bind(null, db)
  // we must intercept close()
  db.close                           = close.bind(null, db)

  startTtl(db, options.checkFrequency)

  return db
}

module.exports = setup
