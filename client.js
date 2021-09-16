const { serve, bufferU8, bufferU16, indexOfBody, indexOfAuth, getAuthTime, closeConnection, writeResponseEarly, writeResponse } = require('./pterodactyl')

const key = new ArrayBuffer(20)

const maxTotalRequestHeadersSize = 8192

const httpEntityTooLargeResponse   = new ArrayBuffer(1)
const httpEntityTooLargeResponseU8 = new Uint8Array(httpEntityTooLargeResponse)

const successfulResponse   = new ArrayBuffer(1)
const successfulResponseU8 = new Uint8Array(successfulResponse)

// Assumes no pipelining - at most a single request is read at a time
function onRequestData(fd, bytes) {

    // If body is not found, implementations should decide
    // whether to buffer further or reject immediately.
    //
    // A valid HTTP server must buffer, and return 413
    // if the buffer is filled without finding bodyStart.
    //
    // This might respond based on reading a single packet, which
    // is considerably smaller than the 8KB of most servers!
    //
    // If you have clients:
    //
    // - With long user-agents, or
    // - Arriving from long referrer URLs, or
    // - Visiting long URLs, or
    // - With long cookies
    //
    // Then buffering up to 8KiB should be done instead.
    //
    // You could alternatively use a reverse proxy in front of Pterodactyl
    // to trim massy headers

    var bodyStart = indexOfBody(bufferU8, bytes, bufferU16)

    if (bodyStart < 0) {
        // Error 413 logic is not handled by Pterodactyl internally
        // to give the app server flexibility to look at x-forwarded-for
        // and authStart to make a decision whether to buffer.
        // In addition, many applications don't expect request
        // headers exceeding 1 packet size.
        if (bytes >= maxTotalRequestHeadersSize) {
            writeResponseEarly(fd, httpEntityTooLargeResponse, httpEntityTooLargeResponseU8, 0, 15)
        } else {
            // Let the client retry -
            // *Hopefully* we get read more data on their next attempt.
            closeConnection(fd)
        }
        return
    }

    var authStart = indexOfAuth(bufferU8, bytes, bufferU16)
    var userStart = indexOfAuthUser(bufferU8, authStart, key)
    var authTime = getAuthTime(bufferU8, authStart)

    setTimeout(() => {
        var buffer = nextchunk
        var offset = 0
        var len = nextchunkSize
        writeResponseHandler(fd, 0)
    }, 100)
}

function writeResponseHandler(fd, outcome) {

    if (outcome) {
        // Buffer write is finished for good or error.
        //
        // If we are streaming something and len === 0
        // start writing the next chunk.
        //
        // Otherwise just release any resources for this request
        return
    }

    // increment the "chunk" number associated with 'fd', supply that.
    var buffer = nextchunk
    var offset = 0
    var len = nextchunkSize

    return writeResponse(fd, buffer, offset, len, writeResponseHandler)
}

// TODO: Scaling:
// hi  wm 60% utilisation total - scale up   double, wait boot+dns time (eg. 30+30s)
// low wm 40% utilisation total - scale down         wait dns+req  time (eg. 30+30s)
// for any factor - mem/cpu/disk/network
// also report any factors in "gross" excess - with less than 20% utilisation

serve(8080, onRequestData)
