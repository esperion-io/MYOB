import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config, hasMyobCredentials } from "./config.js";
import { apiRouter } from "./routes/api.js";
import { authRouter } from "./routes/auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, "../public");

const app = express();

app.use(express.json());
app.use(express.static(publicDir));

app.use("/auth", authRouter);
app.use("/api", apiRouter);

app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api") || req.path.startsWith("/auth")) {
    next();
    return;
  }
  res.sendFile(path.join(publicDir, "index.html"));
});

app.listen(config.port, () => {
  const configured = hasMyobCredentials();
  console.log(`MYOB inventory app listening on ${config.appBaseUrl}`);
  console.log(
    configured
      ? "MYOB credentials detected — visit /auth/login to connect a company file."
      : "MYOB credentials missing — copy .env.example to .env and add your API key/secret.",
  );
});
