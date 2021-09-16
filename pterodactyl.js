const { del } = just.loop
const { errno } = just.sys
const { read, close, EAGAIN } = just.net
const { SOCK_NONBLOCK, SOMAXCONN, IPPROTO_TCP, TCP_NODELAY } = just.net
const { EPOLLET, EPOLLIN, EPOLLOUT } = just.epoll

// Pterodactyl might be useful if you
// - Use a TypeScript/JavaScript stack
// - Want to maximise performance per node
// - Sit behind a reverse proxy such as Cloudflare, CloudFront, Fastly

// Because read/write syscalls are quite expensive,
// we need to read a decent amount of data on each call
const httpConnectionBufferSize = 128 * 1024

// A global receive buffer is used for all connections for assumed cache locality benefits
// If a client receiving a POST can't fully write off the incoming data
// within that call, then it should buffer it internally keyed on 'fd'.
// But for many applications which are GET heavy and use connection pools,
// that is probably rare.
const httpConnectionBuffer = new ArrayBuffer(httpConnectionBufferSize)

const clientBufferU8 = new Uint8Array(httpConnectionBuffer, 0, httpConnectionBufferSize)
const clientBufferU16 = new Uint16Array(httpConnectionBuffer, 0, httpConnectionBufferSize >> 1)

const writeBuffers        = new Map()
const writeBufferSizes    = new Map()
const writeBufferOffsets  = new Map()
const writeBufferHandlers = new Map()
const closeEarlyFds = new Set()

var fdBuffers   = new Map()
var fdBuffersU8 = new Map()

var onRequestData = function () { }

function serve(port, callback) {

  var { add2 } = just.loop
  var { socket, bind, listen, AF_INET, SOCK_STREAM, SOCK_NONBLOCK, SOCK_CLOEXEC } = just.net

  onRequestData = callback

  var listenerfd = socket(AF_INET, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0)

  // TODO: fork once for each core?
  // setsockopt(listenerfd, SOL_SOCKET, SO_REUSEADDR, 1)
  // setsockopt(listenerfd, SOL_SOCKET, SO_REUSEPORT, 1)
  // setsockopt(listenerfd, SOL_SOCKET, SO_INCOMING_CPU, cpu);

  if (bind(listenerfd, '127.0.0.1', port) < 0) throw new Error('bind')
  if (listen(listenerfd, SOMAXCONN) < 0) throw new Error('listen')

  // FIXME: Implement TLS !!!!!
  setHandler1(onHttpConnectionIO)
  setHandler2(onHttpListenerAcceptable)

  add2(listenerfd, EPOLLIN)
}

function onHttpListenerAcceptable(fd) {

  const { accept4, setsockopt } = just.net

  var clientfd = accept4(fd, SOCK_NONBLOCK | SOCK_NONBLOCK)

  if (clientfd < 0)
    return

  setsockopt(clientfd, IPPROTO_TCP, TCP_NODELAY, 1)

  writeBufferSizes.set(fd, 0)
  writeBufferHandlers.set(fd, onHttpConnectionNeverWritten)

  // This is allocating per new connection,
  // but should be acceptable with long-lived reverse proxy connections
  // Could implement a growable single buffer and offsets "freelist"..
  var fdBuffer = new ArrayBuffer(httpConnectionBufferSize)
  fdBuffers.set(fd, fdBuffer)
  fdBuffersU8.set(fd, new Uint8Array(fdBuffer))

  add1(clientfd, EPOLLIN | EPOLLOUT | EPOLLET)
}

function onHttpConnectionNeverWritten() {}

function onHttpConnectionIO(fd, events) {
  if (events & EPOLLIN) {
    onHttpConnectionReadable(fd)
  } else {
    // It's important to send error events to onHttpConnectionWritable,
    // as that gives an opportunity to callback the write handler with outcome=-1 if applicable
    onHttpConnectionWritable(fd, events)
  }
}

function onHttpConnectionReadable(fd) {

  var bytes = read(fd, httpConnectionBuffer, 0, httpConnectionBufferSize)

  if (bytes <= 0) {
    if (errno() !== EAGAIN) {
      closeConnection(fd)
    }
    return
  }

  onRequestData(fd, bytes)
}

function closeConnection(fd) {
  clearConnection(fd)
  close(fd)
}

function clearConnection(fd) {
  closeEarly.delete(fd)
  writeBuffers.delete(fd)
  writeBufferSizes.delete(fd)
  writeBufferOffsets.delete(fd)
  fdBuffers.delete(fd)
  fdBuffersU8.delete(fd)
}

function writeResponseEarlyHandler(fd, state) {
  
}

// DO NOT write more than 128KiB
// DO NOT use fd afterward

function writeResponseEarly(fd, buffer, bufferU8, offset, size) {
  return writeResponse(fd, buffer, bufferU8, offset, size, writeResponseEarlyHandler, true)
}

// DO NOT write more than 128KiB
// DO NOT attempt to write again until you've received outcome=1

function writeResponse(fd, buffer, bufferU8, offset, size, handler, closeEarly) {

  while (true) {

    var len = size - offset

    if (len === 0) {
      if (closeEarly) {
        clearConnection(fd)
        del(fd)
        // A sensible reverse proxy will time out the connection
      }
      handler(fd, 1)
      return 1
    }

    var bytes = write(fd, buffer, offset, len)

    if (bytes <= 0) {
      if (errno() !== EAGAIN) {
        closeConnection(fd)
        handler(fd, -1)
        return -1
      } else {
        var fdBuffer = fdBuffers.get(fd)
        var fdBufferU8 = fdBuffersU8.get(fd)

        var i = len
        while (i --> 0) {
          fdBufferU8[i] = bufferU8[offset + i]
        }

        writeBuffers.set(fd, fdBuffer)
        writeBufferOffsets.set(fd, 0)
        writeBufferSizes.set(fd, len)
        writeBufferHandlers.set(fd, handler)

        if (closeEarly) {
          closeEarlyFds.add(fd)
        }
        return 0
      }
    }

    offset += bytes
  }
}

function onHttpConnectionWritable(fd, events) {

  var size = writeBufferSizes.get(fd)

  if (size === 0) {
    if (events !== EPOLLOUT) {
      closeConnection(fd)
    }
    return
  }

  var buffer = writeBuffers.get(fd)
  var offset = writeBufferOffsets.get(fd)

  while (true) {

    var len = size - offset

    if (len === 0) {
      var handler = writeBufferHandlers.get(fd)
      if (closeEarlyFds.has(fd)) {
        clearConnection(fd)
        del(fd)
        // A sensible reverse proxy will then time out the connection
      }
      handler(fd, 1)
      return
    }

    var bytes = write(fd, buffer, offset, len)

    if (bytes <= 0) {
      if (errno() !== EAGAIN) {
        var handler = writeBufferHandlers.get(fd)
        closeConnection(fd)
        handler(fd, -1)
      } else {
        writeBufferOffsets.set(fd, offset)
      }
      return
    }

    offset += bytes
  }
}

function indexOfBody(bufU8, bytes, bufU16) {

  // Check for \r\n\r\n

  // FIXME: just use strstr ?
  // JS is fundamentally limited by SMI being smaller than 32 bit

  var shorts = bytes >> 1
  var bodyStart = -1
  var codepair = 0x0000
  var i = shorts

  while (i --> 0) {
    codepair = bufU16[i]
    if (codepair | 0x0d0a | 0x0a0d === 0x0f0f) {
      // Assumes little-endian
      if (codepair === 0x0a0d) {
        if (bufU16[i - 1] === 0x0a0d) {
          bodyStart = (i + 1) * 2
          break
        }
      } else {
        bodyStart = (i * 2) + 3
        if (bufU8[bodyStart - 1] === 0x0a && bufU8[bodyStart - 4] === 0x0d) {
          break
        }
        bodyStart = -1
      }
    }
  }

  return bodyStart
}

function indexOfAuth(bufU8, bytes, bufU16) {

  // Check for "QQQQQQQQQQQQQQQQ=(ver:1)(mac:32)(ver:1)(uid:32)(ts:8)"

  // FIXME: just use strstr ?

  var shorts = bytes >> 1
  var j = 0, k = 0
  var chr = 0

  var cookieNameLength = 16
  var cookieAssignmentSize = 1 + 1 + 32 + 1 + 32 + 8
  i = shorts - (cookieAssignmentSize >> 1)

  var authStart = -1

  while (i --> 0) {
    codepair = bufU16[i]
    if (codepair === 0x5151 && i >= (cookieNameLength >> 1) - 1) {
      for (j = (i + 1) * 2; j < bytes; ++j) {
        chr = bufU8[j]
        if (chr === 0x51) {
          continue
        } else if (chr === 0x3d && (bytes - j) >= cookieAssignmentSize) {
          for (k = j - cookieNameLength; k < j && bufU8[k] === 0x51; ++k) {}
          if (k === j) {
            authStart = j + 1
          }
          break
        } else {
          break
        }
      }
      if (authStart >= 0) {
        break
      }
      // This is at best a value QQ like 12345678=QQ
      i -= (cookieNameLength >> 1) - 1
    } else {
      // supposing we saw 8= of  12345678=  then go back another 2 (once more on the loop)
      i -= (cookieNameLength >> 1) - 2
    }
  }

  return authStart
}

function indexOfAuthUser(bufU8, authStart, key) {
  var user = -1

  if (authStart >= 0 && bufU8[authStart] === 0x41 && bufU8[authStart + 1 + 32] === 0x41) {
    // now check the mac of the data, including version.
  }

  return user
}

function getAuthTime(bufU8, authStart) {
  var authTime = -1

  if (authStart >= 0 && bufU8[authStart] === 0x41) {
    // now check the mac of the data, including version.
  }

  return authTime
}

var pterodactyl = {

  buffer: httpConnectionBuffer,
  bufferU8: clientBufferU8,
  bufferU16: clientBufferU16,

  serve,

  indexOfBody,

  indexOfAuth,
  indexOfAuthUser,
  getAuthTime,

  closeConnection,
  writeResponseEarly,
  writeResponse
}

module.exports = pterodactyl