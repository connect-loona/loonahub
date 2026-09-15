// The static ESM import makes Netlify's Runtime V2 bundler include @netlify/blobs in every
// Visual Studio function that stores or reads image bytes. Do not move this back to a lazy
// CommonJS require in visual-assets.js: that dependency was omitted from the deployed bundle
// and broke reference upload in production.
import { getStore } from "@netlify/blobs";
import assets from "../lib/strategy/visual-assets.js";

assets.configureNetlifyStore(getStore);

export default assets;
