// Visual Studio's shapes, mirroring what the backend actually writes — see
// netlify/functions/lib/strategy/visual-chats.js and visual-memory.js.

// A brand as Visual Studio shows it. Comes from Hub's own `brands` node, which is the source
// of truth for which brands exist (the same rule Strategy OS's New Run picker follows).
export interface VisualBrand {
  id: string;
  name: string;
  // Hub stores a logo per brand (see index.html's brand cards, which render b.logo and fall
  // back to a coloured dot). Absent for brands nobody has uploaded one for yet.
  logo?: string | null;
}

// A reference the person has attached but not sent yet. Lives only in the browser: nothing is
// hosted, so the bytes go straight from their machine through the function to the provider.
// What survives afterwards is the ROLE — see visual-generate.js's referenceNote.
export interface PendingReference {
  dataUrl: string;
  name: string;
  role: string;
  file?: File;
  assetKey?: string;
  contentType?: string;
  warnings?: string[];
}

export interface VisualChat {
  id: string;
  brandId: string;
  title: string;
  createdAt: string;
  createdBy: string;
  lastActivityAt?: string;
  generationCount?: number;
}

export interface GeneratedImage {
  url: string | null;
  assetKey?: string | null;
  durable?: boolean;
  contentType?: string | null;
  byteLength?: number | null;
  // What the provider decided to actually generate, when it rewrites the prompt. Worth showing
  // — it's often the explanation for why an image came out the way it did.
  revisedPrompt?: string | null;
}

// A rule that genuinely shaped the image, as a sentence prepended to the prompt — never a
// decorative toggle. See visual-rules.js for why that distinction is load-bearing.
export interface AppliedRule {
  key: string;
  label: string;
  source: "standard" | "brand";
}

export interface Generation {
  id: string;
  chatId: string | null;
  prompt: string;
  provider: string;
  operation?: "generate" | "magnific_precision";
  providerTaskId?: string | null;
  model?: string | null;
  actor: string;
  images: GeneratedImage[];
  appliedRules?: AppliedRule[];
  // What the image model was actually asked for, once the person's words were expanded with
  // the conversation and the brand's memory (see visual-prompt.js). Null when no rewrite
  // happened. Worth showing: it's the only way to tell a bad image from a bad rewrite.
  expandedPrompt?: string | null;
  // "draft" or "final" — a soft-looking image is explained by this rather than looking like
  // the model underperforming.
  quality?: "draft" | "final";
  // The shape key this round was made at — matches a key in Composer's SIZES / the functions'
  // image-shapes.js. Absent on anything recorded before shapes existed. Read back to carry the
  // same shape into a follow-up rather than making someone reselect it every round.
  size?: string | null;
  createdAt: string;
  // Provider image URLs expire (OpenAI's in about an hour). The backend says plainly whether
  // a preview is still worth rendering, so this shows an honest "expired" state rather than
  // a broken image. The prompt and the pick survive regardless.
  previewExpired?: boolean;
  pickedIndex: number | null;
  pickedAt?: string | null;
  pickedBy?: string | null;
  pickNote?: string | null;
  pickTags?: string[];
  referenceCount?: number;
  referenceNote?: string | null;
  referenceAssets?: Array<{ assetKey: string; name?: string; role?: string; contentType?: string }>;
  parentGenerationId?: string | null;
  parentImageIndex?: number | null;
  suggestions?: string[];
  qc?: VisualQc | null;
}

export interface VisualQcCheck {
  status: "pass" | "warn" | "fail" | "not_checked";
  issues: string[];
}

export interface VisualQc {
  checkedAt: string;
  checkedByModel?: string;
  summary: string;
  checks: Record<string, VisualQcCheck>;
}
