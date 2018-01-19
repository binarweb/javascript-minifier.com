// --------------------------------------------------------------------------------------------------------------------

// core
const fs = require('fs')
const path = require('path')
const md5File = require('md5-file')

// npm
const uglify = require('uglify-js')
const redis = require('redis')
const bole = require('bole')

// --------------------------------------------------------------------------------------------------------------------
// setup

const log = bole('lib/minify')

const isProd = process.env.NODE_ENV === 'production'

const oneMinInSecs        = 60 // in seconds
const oneHourInSecs       = 24 * 60 * 60 // in seconds
const oneDayInSecs        = 24 * 60 * 60 // in seconds
const halfDayInSecs       = oneDayInSecs / 2 // in seconds
const blockTimeInSecs     = isProd ? oneHourInSecs : oneMinInSecs
const cacheFileTimeInSecs = isProd ? halfDayInSecs : oneMinInSecs

const tenSecsInMs = 10 * 1000
const tenMinsInMs = 10 * 60 * 1000
const removeFileTimeInMs  = isProd ? tenSecsInMs : tenMinsInMs

// file/exec dirs and locations
const libDir = '/var/lib/javascript-minifier'

// redis
const client = redis.createClient()
client.on("error", err => {
  log.info("Redis Error: " + err)
})

// --------------------------------------------------------------------------------------------------------------------
// functions

function removeFile(filename) {
  log.info('removeFile() - removing file shortly : ' + filename)
  // remove this file in 10s
  setTimeout(() => {
    fs.unlink(filename, err => {
      if (err) return log.error('Error removing file:', err)
      log.info('File removed: ' + filename)
    })
  }, removeFileTimeInMs)
}

function doit(rid, js, callback) {
  // Here, there are three things to do:
  // 1. Write the file to the filesystem
  // 2. Check the md5 and see if we have a cached file. If so, send it.
  // 3. Call UglifyJS to minify the input to the output
  // 4. Send the result back.

  // write this input to a file
  var orgFilename = path.join(libDir, rid + '.js')

  fs.writeFile(orgFilename, js, (err) => {
    if (err) return callback(err)

    // do an MD5 of the file so we can check if we've done it before
    md5File(orgFilename, (err, hash) => {
      if (err) return log.error('Error doing MD5 hash: ', err)
      log.info('md5=' + hash)

      // create the minified file's location
      var minFilename = path.join(libDir, '/' + hash + '.min.js')

      // see if a `jsminifier:hash:${hash}` key exists, and re-use that file to send, instead of doing the minification
      const hashKey = `jsminifier:hash:${hash}`
      client.get(hashKey, (err, result) => {
        log.info('get hashKey:', err, result)

        // yes, this file still exists
        if ( result ) {
          log.info('A cache file should already be there : ' + minFilename)

          // read the file back and return it to the caller
          fs.readFile(minFilename, (err, newJs) => {
            if (err) return callback(err)

            // remove the original file after some time, the cron job will tidy-up old minified files
            removeFile(orgFilename)

            // callback with the minified styles
            callback(null, newJs, { code : newJs })
          })

          // nothing more to do
          return
        }

        // Before doing the minification, check if we can set `file:hash` in Redis since that'll show us if either one is
        // in-progress, or if it is hanging around that it failed.
        const fileKey = `jsminifier:try:${hash}`
        client.set(fileKey, rid, 'EX', blockTimeInSecs, 'NX', (err, ok) => {
          if (err) return log.error('Redis.set failed :', err)
          log.info('Key set in Redis:', fileKey)

          // if the set failed, then we return that there is already one in progress
          if ( !ok ) {
            callback(null, '// Error: Concurrent processing of the same file - try again later.\n')
            removeFile(orgFilename)
            return
          }

          var minified = ''

          // perform the minification, and check for any error
          const result = uglify.minify(js)
          if ( result.error ) {
            log.info('Invalid input : ' + result.error.message)
            minified = [
              '// Error : ' + result.error.message,
              '// Line  : ' + result.error.line,
              '// Col   : ' + result.error.col,
            ].join('\n')

            // since there was a problem minifying the file, leave the key in Redis
          }
          else {
            // minification went well
            minified = result.code
          }

          // write this output to the minFilename
          log.info('Writing cachefile to ' + minFilename)
          fs.writeFile(minFilename, minified, err => {
            if (err) return callback(err, null, result)

            // remove the fileKey from Redis, so the file can be reprocessed in the future
            client.del(fileKey, err => {
              if (err) return log.error('Error when removing fileKey from Redis:', err)
              log.info('Key deleted from Redis:', fileKey)
            })

            // set a `hash:${hash}` key in Redis so we can re-send this file for future uploads of the same file
            client.set(hashKey, Date.now(), 'EX', cacheFileTimeInSecs, (err, result) => {
              log.info('set hashKey:', err, result)
            })

            // Remove the original file some time later.
            // The cron job will tidy-up old minified files every so often.
            removeFile(orgFilename)

            callback(null, minified, result)
          })
        })
      })
    })
  })
}

// minify() swallows errors and always returns text to be sent back
function minify(rid, js, callback) {
  doit(rid, js, (err, minified, result) => {
    if (err) {
      log.info('Error when minifying : ' + err)
      callback('// Internal Server Error')
      return
    }

    if ( result.error ) {
      log.info('Invalid input : ' + result.error.message)
      const msg = [
        '// Error : ' + result.error.message,
        '// Line  : ' + result.error.line,
        '// Col   : ' + result.error.col,
      ].join('\n')
      callback(msg)
      return
    }

    // all good
    callback(minified)
  })
}

// --------------------------------------------------------------------------------------------------------------------

module.exports = minify

// --------------------------------------------------------------------------------------------------------------------