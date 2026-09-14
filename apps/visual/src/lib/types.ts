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
  model?: string | null;
  actor: string;
  images: GeneratedImage[];
  appliedRules?: AppliedRule[];
  createdAt: string;
  // Provider image URLs expire (OpenAI's in about an hour). The backend says plainly whether
  // a preview is still worth rendering, so this shows an honest "expired" state rather than
  // a broken image. The prompt and the pick survive regardless.
  previewExpired?: boolean;
  pickedIndex: number | null;
  pickedAt?: string | null;
  pickedBy?: string | null;
  pickNote?: string | null;
  referenceCount?: number;
  referenceNote?: string | null;
}
