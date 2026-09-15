// What shape an image comes out, and how each provider is made to produce it.
//
// This file exists because the three shapes Visual Studio shipped with were named for
// placements they did not actually fit. "Portrait (reel, story)" generated 1024x1536 — that is
// 2:3 (0.667), and a reel or a story is 9:16 (0.563). "Landscape (banner)" generated 3:2 where
// a banner wants 16:9. Nothing downstream cropped, so whatever the provider returned is what
// got posted, and Instagram picked its own crop on the way in. Every reel cover made here was
// the wrong shape for where it was going.
//
// THE CONSTRAINT THAT SHAPES EVERYTHING ELSE: gpt-image-1 accepts exactly three sizes —
// 1024x1024, 1024x1536 and 1536x1024. There is no parameter for 4:5, and asking for one is a
// 400, not a resize. So an exact ratio cannot be requested; it has to be MADE. Every shape here
// therefore names a `base` the provider can genuinely produce, and the exact ratio is reached
// by cropping that base afterwards (see cropToShape).
//
// Cropping deliberately is not a compromise against asking natively — it is better than the
// status quo, where Instagram crops a 2:3 image to 4:5 by its own rules and nobody sees the
// result until it is live. Here the trim is centred, predictable, and the model is told it is
// coming (see promptForShape) so the subject is composed to survive it.
"use strict";

// Keys are ratios, not placement names, on purpose. The bug above happened because `portrait`
// could drift from the thing it promised; `9x16` cannot mean anything other than 9:16.
const SHAPES = {
  "9x16": {
    label: "Story / Reel (9:16)", ratio: [9, 16], offered: true,
    openai: "1024x1536", magnific: "portrait_2_3",
  },
  "4x5": {
    label: "Feed portrait (4:5)", ratio: [4, 5], offered: true,
    openai: "1024x1536", magnific: "portrait_2_3",
  },
  "3x4": {
    label: "Portrait (3:4)", ratio: [3, 4], offered: true,
    openai: "1024x1536", magnific: "portrait_2_3",
  },
  "1x1": {
    label: "Square (1:1)", ratio: [1, 1], offered: true,
    openai: "1024x1024", magnific: "square_1_1",
  },
  "16x9": {
    label: "Landscape (16:9)", ratio: [16, 9], offered: true,
    openai: "1536x1024", magnific: "standard_3_2",
  },
  // Not offered any more, but still resolvable: every generation already stored carries one of
  // these, and an old chat must re-render as the image that was actually made rather than
  // silently re-cropped to something its creator never saw.
  "2x3": {
    label: "Portrait (2:3)", ratio: [2, 3], offered: false,
    openai: "1024x1536", magnific: "portrait_2_3",
  },
  "3x2": {
    label: "Landscape (3:2)", ratio: [3, 2], offered: false,
    openai: "1536x1024", magnific: "standard_3_2",
  },
};

// The names the app sent before this file existed. `square` was always honest; the other two
// were not, and they alias to the ratio they really produced, not the one they claimed.
const LEGACY_KEYS = { square: "1x1", portrait: "2x3", landscape: "3x2" };

const DEFAULT_SHAPE = "4x5";

function shapeKey(size) {
  const raw = String(size || "").trim();
  if (!raw) return DEFAULT_SHAPE;
  if (SHAPES[raw]) return raw;
  if (LEGACY_KEYS[raw]) return LEGACY_KEYS[raw];
  return null;
}

function shapeFor(size) {
  const key = shapeKey(size);
  if (!key) {
    const offered = Object.keys(SHAPES).filter((k) => SHAPES[k].offered).join(", ");
    throw new Error(`Unknown image shape "${size}". Use one of: ${offered}.`);
  }
  return { key, ...SHAPES[key] };
}

function offeredShapes() {
  return Object.keys(SHAPES).filter((key) => SHAPES[key].offered)
    .map((key) => ({ key, label: SHAPES[key].label, ratio: SHAPES[key].ratio }));
}

// The largest box of EXACTLY ratioW:ratioH that fits inside sourceW x sourceH, centred.
//
// Integer-exact by construction rather than by rounding: scaling the ratio by a whole number
// can only ever produce a box that reduces back to the same ratio. Rounding a computed edge
// (1024 / 0.75 = 1365.33) would leave 1024x1365, which is 0.7502 — near enough to look right in
// a test and wrong enough to be letterboxed by a platform that checks.
function cropBox(sourceW, sourceH, ratioW, ratioH) {
  const scale = Math.min(Math.floor(sourceW / ratioW), Math.floor(sourceH / ratioH));
  if (scale < 1) throw new Error(`Cannot fit ${ratioW}:${ratioH} inside ${sourceW}x${sourceH}.`);
  const width = scale * ratioW;
  const height = scale * ratioH;
  return {
    x: Math.floor((sourceW - width) / 2),
    y: Math.floor((sourceH - height) / 2),
    width,
    height,
    // A crop that takes the whole frame is not a crop, and saying so lets the caller skip a
    // decode/re-encode round trip that would only cost quality for no change in shape.
    needed: width !== sourceW || height !== sourceH,
  };
}

// What the provider is asked for, before any cropping.
function baseSizeForOpenAI(size) { return shapeFor(size).openai; }
function baseRatioForMagnific(size) { return shapeFor(size).magnific; }

// Telling the model the trim is coming is the difference between a 9:16 crop that works and one
// that cuts a hand off. It is appended to the prompt SENT, never to the prompt stored: the
// person's own words are what gets shown back to them and read into Loona Brain.
function promptForShape(prompt, size) {
  const shape = shapeFor(size);
  const [ratioW, ratioH] = shape.ratio;
  const base = shape.openai;
  const [baseW, baseH] = base.split("x").map(Number);
  const box = cropBox(baseW, baseH, ratioW, ratioH);
  if (!box.needed) return prompt;
  const trimmed = box.width === baseW ? "top and bottom" : "left and right";
  return `${prompt}\n\nComposition: this image will be cropped to exactly ${ratioW}:${ratioH} from the centre, losing the ${trimmed} edges. Keep the subject, any product and any text comfortably inside that central ${ratioW}:${ratioH} area.`;
}

// Crop after the fact. deps.readImage is injected by tests so the maths is exercisable without
// decoding a real image; production passes jimp.
//
// A generation that reaches here has already been paid for and waited on, so nothing in this
// function is allowed to destroy it. If the image is somehow too small to hold the ratio, or
// the decoder can't read it at all, the original bytes are returned with the reason recorded
// rather than an exception thrown — the wrong shape is a problem, but a lost image is a worse
// one, and `cropped: false` plus a reason is how the caller can say so.
async function cropToShape(buffer, contentType, size, deps = {}) {
  const asIs = (reason) => ({ buffer, contentType, width: null, height: null, cropped: false, reason });
  // Resolving the shape is inside the guarantee, not before it. shapeFor throws on an unknown
  // shape — correct when validating a request, fatal here, because by this point the image has
  // been generated and paid for and throwing would discard it.
  let shape;
  try {
    shape = shapeFor(size);
  } catch (error) {
    return asIs(`Could not work out the shape to crop to: ${error.message}`);
  }
  const [ratioW, ratioH] = shape.ratio;
  const read = deps.readImage || defaultReadImage;
  let image;
  try {
    image = await read(buffer);
  } catch (error) {
    return asIs(`Could not read the generated image to crop it: ${error.message}`);
  }
  if (!image.width || !image.height) return asIs("The generated image had no readable dimensions.");
  let box;
  try {
    box = cropBox(image.width, image.height, ratioW, ratioH);
  } catch {
    return asIs(`A ${image.width}x${image.height} image is too small to crop to ${ratioW}:${ratioH}.`);
  }
  if (!box.needed) {
    return { buffer, contentType, width: image.width, height: image.height, cropped: false };
  }
  try {
    const out = await image.crop(box, contentType);
    return { buffer: out, contentType, width: box.width, height: box.height, cropped: true };
  } catch (error) {
    return asIs(`Could not crop the generated image to ${ratioW}:${ratioH}: ${error.message}`);
  }
}

// jimp rather than sharp deliberately: sharp is a native binary, and bundling one into a
// Netlify function is exactly the class of deploy risk this site spent two days stuck behind.
// jimp is pure JavaScript, so it bundles like any other module. Its cost is speed, and speed is
// free here — this runs after a provider call that already took 10-90 seconds, so a few hundred
// milliseconds of decoding changes nothing anybody can feel.
//
// Composed from the two codecs and the one plugin actually needed, rather than imported whole.
// `require("jimp")` pulls every format (bmp, gif, tiff) and every plugin (blur, resize, fonts,
// dithering) into the bundle: measured at 3.6MB against 723KB for this. That weight would land
// on every function that touches visual-assets, not just this path.
let composedJimp = null;
function jimp() {
  if (composedJimp) return composedJimp;
  const { createJimp } = require("@jimp/core");
  const png = require("@jimp/js-png");
  const jpeg = require("@jimp/js-jpeg");
  const crop = require("@jimp/plugin-crop");
  composedJimp = createJimp({
    formats: [png.default || png, jpeg.default || jpeg],
    plugins: [crop.methods || crop],
  });
  return composedJimp;
}

async function defaultReadImage(buffer) {
  const image = await jimp().read(buffer);
  return {
    width: image.bitmap.width,
    height: image.bitmap.height,
    async crop(box, contentType) {
      image.crop({ x: box.x, y: box.y, w: box.width, h: box.height });
      return image.getBuffer(contentType === "image/jpeg" ? "image/jpeg" : "image/png");
    },
  };
}

module.exports = {
  SHAPES, LEGACY_KEYS, DEFAULT_SHAPE,
  shapeKey, shapeFor, offeredShapes, cropBox,
  baseSizeForOpenAI, baseRatioForMagnific, promptForShape, cropToShape,
};
