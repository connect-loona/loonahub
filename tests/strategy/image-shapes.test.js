// What shape an image actually comes out.
//
// This exists because the shapes that shipped were named for placements they didn't fit:
// "Portrait (reel, story)" produced 2:3 where a reel is 9:16, and nothing cropped afterwards,
// so the wrong shape is what got posted. The checks below are mostly about EXACTNESS — a ratio
// that is nearly right is the failure mode here, because it looks correct in a review and gets
// letterboxed by the platform.
const path = require("path");
const { HUB, check, finish } = require("../harness/shared");
const {
  SHAPES, DEFAULT_SHAPE, shapeKey, shapeFor, offeredShapes, cropBox,
  baseSizeForOpenAI, baseRatioForMagnific, promptForShape, cropToShape,
} = require(path.join(HUB, "netlify/functions/lib/strategy/image-shapes"));

// A stand-in for jimp: the crop maths is what's worth pinning, and it shouldn't need a real
// PNG decoder to be exercised. The production path is proven separately against real bytes.
function fakeImage(width, height) {
  return {
    async readImage() { return this; },
    width, height,
    async crop(box) { return Buffer.from(`cropped:${box.width}x${box.height}@${box.x},${box.y}`); },
  };
}
const deps = (w, h) => ({ readImage: async () => fakeImage(w, h) });

(async () => {
  // ---- Every offered shape is EXACTLY its ratio ----
  // Integer-exact, not rounded: 1024/0.75 is 1365.33, and storing 1024x1365 would be 0.7502.
  for (const { key, ratio } of offeredShapes()) {
    const [rw, rh] = ratio;
    const base = baseSizeForOpenAI(key).split("x").map(Number);
    const box = cropBox(base[0], base[1], rw, rh);
    check(`${key} crops to exactly ${rw}:${rh}`, box.width * rh === box.height * rw,
      `${box.width}x${box.height}`);
  }

  // ---- The specific boxes, spelled out ----
  const story = cropBox(1024, 1536, 9, 16);
  check("a 9:16 story is 864x1536 out of a 2:3 frame", story.width === 864 && story.height === 1536, story);
  check("and it is taken from the centre, not an edge", story.x === 80 && story.y === 0, story);

  const feed = cropBox(1024, 1536, 4, 5);
  check("a 4:5 feed post is 1024x1280", feed.width === 1024 && feed.height === 1280, feed);
  check("trimmed evenly top and bottom", feed.y === 128 && feed.x === 0, feed);

  const banner = cropBox(1536, 1024, 16, 9);
  check("a 16:9 banner is 1536x864", banner.width === 1536 && banner.height === 864, banner);

  const threeFour = cropBox(1024, 1536, 3, 4);
  check("3:4 is exact rather than rounded", threeFour.width * 4 === threeFour.height * 3,
    `${threeFour.width}x${threeFour.height}`);

  // ---- A square needs no crop, and saying so avoids a pointless re-encode ----
  const square = cropBox(1024, 1024, 1, 1);
  check("a square is already square, so no crop is needed", square.needed === false, square);
  check("but a 9:16 does need one", story.needed === true);

  // ---- Old records still resolve, and to what they REALLY were ----
  // Someone opening a chat from last week must see the image that was made, not a fresh crop
  // of a shape its author never chose.
  check('legacy "portrait" resolves to 2:3, which is what it actually produced', shapeKey("portrait") === "2x3", shapeKey("portrait"));
  check('legacy "landscape" resolves to 3:2', shapeKey("landscape") === "3x2", shapeKey("landscape"));
  check('legacy "square" was always honest, so it maps straight to 1x1', shapeKey("square") === "1x1", shapeKey("square"));
  check("the retired shapes are resolvable but not offered", !SHAPES["2x3"].offered && !SHAPES["3x2"].offered);
  check("the dropdown offers exactly the five social shapes",
    offeredShapes().map((s) => s.key).join(",") === "9x16,4x5,3x4,1x1,16x9", offeredShapes().map((s) => s.key));

  // ---- An unknown shape fails loudly ----
  // The Magnific provider used to end `|| "square_1_1"`, so an unrecognised shape came back
  // silently square. A wrong-shaped image that nobody was warned about reaches a client.
  let threw = null;
  try { shapeFor("panorama"); } catch (e) { threw = e; }
  check("an unknown shape throws rather than defaulting to a square", Boolean(threw), threw && threw.message);
  check("and the message says what can be used instead", /9x16/.test(threw.message), threw.message);
  check("a raw WIDTHxHEIGHT is refused too — OpenAI would reject it anyway",
    (() => { try { shapeFor("1024x1280"); return false; } catch { return true; } })());
  check("an empty shape falls back to the default rather than throwing", shapeKey("") === DEFAULT_SHAPE);

  // ---- Providers are asked for something they can actually produce ----
  check("9:16 generates at OpenAI's 2:3, the nearest it offers", baseSizeForOpenAI("9x16") === "1024x1536");
  check("4:5 generates at 2:3 as well", baseSizeForOpenAI("4x5") === "1024x1536");
  check("16:9 generates at 3:2", baseSizeForOpenAI("16x9") === "1536x1024");
  check("1:1 generates square", baseSizeForOpenAI("1x1") === "1024x1024");
  for (const { key } of offeredShapes()) {
    check(`${key} only ever asks Magnific for a ratio this codebase has seen it accept`,
      ["square_1_1", "portrait_2_3", "standard_3_2"].includes(baseRatioForMagnific(key)), baseRatioForMagnific(key));
  }

  // ---- The model is told the trim is coming ----
  // Without this a 9:16 crop takes 16% off the width of a composition that used all of it.
  const hinted = promptForShape("A bottle on wet stone", "9x16");
  check("the prompt sent says what the crop will be", /exactly 9:16/.test(hinted), hinted);
  check("and which edges go", /left and right/.test(hinted), hinted);
  check("a 4:5 loses top and bottom instead", /top and bottom/.test(promptForShape("x", "4x5")));
  check("the person's own words survive at the front", hinted.startsWith("A bottle on wet stone"));
  check("a square needs no warning, so it gets none", promptForShape("A bottle", "1x1") === "A bottle");

  // ---- Cropping reports the shape it produced ----
  const cropped = await cropToShape(Buffer.from("x"), "image/png", "9x16", deps(1024, 1536));
  check("cropping reports the final dimensions", cropped.width === 864 && cropped.height === 1536, cropped);
  check("and flags that it happened", cropped.cropped === true);

  const untouched = await cropToShape(Buffer.from("original"), "image/png", "1x1", deps(1024, 1024));
  check("an image already the right shape is passed through unchanged",
    untouched.cropped === false && untouched.buffer.toString() === "original", untouched);

  // ---- A crop that can't happen must not destroy a paid generation ----
  // The image has already been waited on and billed. Delivering it unshaped, and saying so, is
  // strictly better than throwing the only copy away.
  const tooSmall = await cropToShape(Buffer.from("tiny"), "image/png", "9x16", deps(1, 1));
  check("an image too small to crop survives instead of throwing",
    tooSmall.cropped === false && tooSmall.buffer.toString() === "tiny", tooSmall);
  check("and the reason travels with it", /too small to crop to 9:16/.test(tooSmall.reason || ""), tooSmall.reason);

  const unreadable = await cropToShape(Buffer.from("not an image"), "image/png", "4x5", {
    readImage: async () => { throw new Error("unsupported format"); },
  });
  check("an undecodable image is kept too, not lost",
    unreadable.cropped === false && unreadable.buffer.toString() === "not an image");
  check("with the decoder's own complaint recorded", /unsupported format/.test(unreadable.reason || ""), unreadable.reason);

  // An unknown shape is a hard error when a REQUEST is being validated, and must not be one
  // here: resolving it happens after the image exists, so throwing would discard a paid image
  // over a bad string.
  const unknownShape = await cropToShape(Buffer.from("real bytes"), "image/png", "panorama", deps(1024, 1536));
  check("an unknown shape at crop time keeps the image rather than throwing",
    unknownShape.cropped === false && unknownShape.buffer.toString() === "real bytes", unknownShape);
  check("and explains itself", /Could not work out the shape/.test(unknownShape.reason || ""), unknownShape.reason);

  // The crop stage as a whole: whatever goes wrong, bytes come back.
  for (const [name, badDeps] of [
    ["a decoder that returns nothing", { readImage: async () => ({}) }],
    ["a decoder that reports zero size", { readImage: async () => ({ width: 0, height: 0 }) }],
    ["a crop that throws mid-encode", { readImage: async () => ({ width: 1024, height: 1536, crop: async () => { throw new Error("out of memory"); } }) }],
  ]) {
    const survived = await cropToShape(Buffer.from("payload"), "image/png", "9x16", badDeps);
    check(`${name} still yields the original image`,
      survived.buffer.toString() === "payload" && survived.cropped === false, survived);
    check(`${name} says why`, Boolean(survived.reason), survived.reason);
  }

  // ---- The real decoder, on real bytes ----
  // Everything above runs on injected maths. This runs the path that actually ships: jimp,
  // decoding and re-encoding genuine image bytes. Without it the crop could be exactly right
  // arithmetically and still produce a corrupt file.
  // Composed exactly as image-shapes.js composes it, so this exercises the codecs that ship
  // rather than the full jimp bundle that doesn't.
  const { createJimp } = require("@jimp/core");
  const pngCodec = require("@jimp/js-png");
  const jpegCodec = require("@jimp/js-jpeg");
  const cropPlugin = require("@jimp/plugin-crop");
  const Jimp = createJimp({
    formats: [pngCodec.default || pngCodec, jpegCodec.default || jpegCodec],
    plugins: [cropPlugin.methods || cropPlugin],
  });
  const source = new Jimp({ width: 1024, height: 1536, color: 0x3366ccff });
  for (const [format, type] of [["image/png", "PNG"], ["image/jpeg", "JPEG"]]) {
    const bytes = await source.getBuffer(format);
    const real = await cropToShape(bytes, format, "9x16");
    check(`a real ${type} crops to 864x1536`, real.width === 864 && real.height === 1536, real);
    // Re-read it: the returned dimensions are a claim, the decoded file is the evidence.
    const reopened = await Jimp.read(real.buffer);
    check(`the written ${type} really is 9:16 when opened again`,
      reopened.bitmap.width * 16 === reopened.bitmap.height * 9,
      `${reopened.bitmap.width}x${reopened.bitmap.height}`);
    check(`and the ${type} stays a readable ${type}`, real.contentType === format);
  }

  finish();
})().catch((e) => { console.error("FATAL:", e, e.stack); process.exit(1); });
