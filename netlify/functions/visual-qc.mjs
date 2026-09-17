// visual-qc — runs on Netlify's current Functions runtime.
//
// The handler itself is unchanged, in _legacy/visual-qc.js. withLambda converts the incoming
// Request into the Lambda-style event it expects, and its response back again.
// See _legacy/README.md for why this wrapper exists.
import { withLambda } from "@netlify/aws-lambda-compat";
import "./_shared/visual-blob-store.mjs";
import { createJimp } from "@jimp/core";
globalThis.__jimpCoreBundled = createJimp;
import jimpPng from "@jimp/js-png";
globalThis.__jimpPngBundled = jimpPng;
import jimpJpeg from "@jimp/js-jpeg";
globalThis.__jimpJpegBundled = jimpJpeg;
import { methods } from "@jimp/plugin-crop";
globalThis.__jimpCropBundled = methods;
import legacy from "./_legacy/visual-qc.js";

export default withLambda(legacy.handler);
