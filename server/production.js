import express from "express";
import httpProxy from "http-proxy";

import {
  createServer,
} from "node:http";

import {
  spawn,
} from "node:child_process";

import {
  fileURLToPath,
} from "node:url";

import path from "node:path";


/*
 * --------------------------------
 * PATHS + PORTS
 * --------------------------------
 */

const __filename =
  fileURLToPath(
    import.meta.url
  );

const __dirname =
  path.dirname(
    __filename
  );

const backendPort =
  3001;

const publicPort =
  Number(
    process.env.PORT
  ) ||
  8080;


/*
 * The existing server.js listens on
 * port 3001. production.js owns the
 * public Railway port.
 */

if (
  publicPort ===
  backendPort
) {
  throw new Error(
    "Production PORT cannot be 3001. Set PORT to 8080."
  );
}


const backendUrl =
  `http://127.0.0.1:${backendPort}`;

const backendEntry =
  path.join(
    __dirname,
    "server.js"
  );

const clientDist =
  path.resolve(
    __dirname,
    "../client/dist"
  );

const clientIndex =
  path.join(
    clientDist,
    "index.html"
  );


/*
 * --------------------------------
 * START EXISTING GAME SERVER
 * --------------------------------
 */

console.log(
  "Starting BuzzBoard game server..."
);

const backendProcess =
  spawn(
    process.execPath,

    [
      backendEntry,
    ],

    {
      stdio:
        "inherit",

      env: {
        ...process.env,

        NODE_ENV:
          process.env.NODE_ENV ??
          "production",
      },
    }
  );


/*
 * --------------------------------
 * INTERNAL HTTP + WEBSOCKET PROXY
 * --------------------------------
 */

const proxy =
  httpProxy
    .createProxyServer({
      target:
        backendUrl,

      ws:
        true,

      changeOrigin:
        true,
    });


proxy.on(
  "error",

  (
    error,
    request,
    response
  ) => {
    console.error(
      "BuzzBoard proxy error:",
      error
    );

    /*
     * WebSocket errors do not have a
     * normal Express response object.
     */

    if (
      response &&
      "writeHead" in
        response
    ) {
      if (
        !response
          .headersSent
      ) {
        response.writeHead(
          502,
          {
            "Content-Type":
              "application/json",
          }
        );
      }

      response.end(
        JSON.stringify({
          error:
            "BuzzBoard game server unavailable",
        })
      );
    }
  }
);


/*
 * --------------------------------
 * PUBLIC EXPRESS APP
 * --------------------------------
 */

const app =
  express();


/*
 * Forward Discord OAuth API calls
 * and Socket.IO polling traffic to
 * the existing server.js process.
 */

app.use(
  (
    request,
    response,
    next
  ) => {
    const requestUrl =
      request.url ??
      "";

    const isApiRequest =
      requestUrl ===
        "/api" ||
      requestUrl.startsWith(
        "/api/"
      );

    const isSocketRequest =
      requestUrl ===
        "/socket.io" ||
      requestUrl.startsWith(
        "/socket.io/"
      ) ||
      requestUrl.startsWith(
        "/socket.io?"
      );

    if (
      isApiRequest ||
      isSocketRequest
    ) {
      proxy.web(
        request,
        response
      );

      return;
    }

    next();
  }
);


/*
 * Serve the Vite production build.
 */

app.use(
  express.static(
    clientDist,
    {
      index:
        false,
    }
  )
);


/*
 * React SPA fallback.
 *
 * Any normal GET request that was
 * not a static asset is sent to the
 * client entry page.
 */

app.use(
  (
    request,
    response,
    next
  ) => {
    if (
      request.method !==
      "GET"
    ) {
      next();

      return;
    }

    response.sendFile(
      clientIndex
    );
  }
);


/*
 * --------------------------------
 * PUBLIC SERVER + WEBSOCKETS
 * --------------------------------
 */

const publicServer =
  createServer(
    app
  );


publicServer.on(
  "upgrade",

  (
    request,
    socket,
    head
  ) => {
    const requestUrl =
      request.url ??
      "";

    if (
      requestUrl.startsWith(
        "/socket.io"
      )
    ) {
      proxy.ws(
        request,
        socket,
        head
      );

      return;
    }

    socket.destroy();
  }
);


publicServer.listen(
  publicPort,
  "0.0.0.0",

  () => {
    console.log(
      `BuzzBoard production server running on port ${publicPort}`
    );

    console.log(
      `Static client: ${clientDist}`
    );

    console.log(
      `Game server proxy: ${backendUrl}`
    );
  }
);


/*
 * --------------------------------
 * CHILD PROCESS SAFETY
 * --------------------------------
 */

let shuttingDown =
  false;


backendProcess.on(
  "exit",

  (
    code,
    signal
  ) => {
    if (
      shuttingDown
    ) {
      return;
    }

    console.error(
      "BuzzBoard game server exited unexpectedly.",
      {
        code,
        signal,
      }
    );

    publicServer.close(
      () => {
        process.exit(
          code ??
          1
        );
      }
    );

    setTimeout(
      () => {
        process.exit(
          code ??
          1
        );
      },

      1500
    ).unref();
  }
);


function shutdown(
  signal
) {
  if (
    shuttingDown
  ) {
    return;
  }

  shuttingDown =
    true;

  console.log(
    `BuzzBoard shutting down (${signal})...`
  );


  if (
    !backendProcess.killed
  ) {
    backendProcess.kill(
      signal
    );
  }


  publicServer.close(
    () => {
      process.exit(
        0
      );
    }
  );


  /*
   * Safety valve in case a connection
   * refuses to close cleanly.
   */

  setTimeout(
    () => {
      process.exit(
        0
      );
    },

    5000
  ).unref();
}


process.on(
  "SIGTERM",

  () => {
    shutdown(
      "SIGTERM"
    );
  }
);


process.on(
  "SIGINT",

  () => {
    shutdown(
      "SIGINT"
    );
  }
);