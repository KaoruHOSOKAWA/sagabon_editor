const http = require("http");
const fs = require("fs");
const path = require("path");
const rootDir = __dirname;
const publicDir = path.join(rootDir, "public");
const metadataPath = path.join(publicDir, "font-metadata.json");
const fontPath = path.join(rootDir, "SagabonPrototype.otf");

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".otf": "font/otf",
  ".svg": "image/svg+xml; charset=utf-8"
};

function ensureMetadata() {
  if (!fs.existsSync(metadataPath)) {
    throw new Error(
      "font-metadata.json is missing. Generate it in advance and distribute it with the app."
    );
  }
}

function sendFile(response, filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const contentType = mimeTypes[extension] || "application/octet-stream";

  fs.readFile(filePath, (error, data) => {
    if (error) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }

    response.writeHead(200, { "Content-Type": contentType });
    response.end(data);
  });
}

ensureMetadata();

const server = http.createServer((request, response) => {
  const requestPath = request.url === "/" ? "/index.html" : request.url.split("?")[0];

  if (requestPath === "/SagabonPrototype.otf") {
    sendFile(response, fontPath);
    return;
  }

  const safePath = path.normalize(decodeURIComponent(requestPath)).replace(/^[/\\]+/, "").replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(publicDir, safePath);

  if (!filePath.startsWith(publicDir)) {
    response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Forbidden");
    return;
  }

  sendFile(response, filePath);
});

const port = Number(process.env.PORT) || 3000;
server.listen(port, () => {
  console.log(`Sagabon typesetter: http://localhost:${port}`);
});
