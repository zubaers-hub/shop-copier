// Mode 2 image analysis with Claude, called straight from the phone's browser with the key saved in Settings.
import Anthropic from '@anthropic-ai/sdk';

export const CABINET_TYPES = [
  'base', 'sink_base', 'drawer_base', 'corner_base', 'blind_corner_base', 'wall', 'corner_wall', 'tall', 'pantry',
  'oven_tall', 'vanity', 'open_shelf', 'appliance_opening', 'filler', 'end_panel', 'other',
];
export const DECOR_TYPES = ['valance', 'corbel', 'bracket', 'arched_door_top', 'decorative_end_panel', 'applied_molding', 'cutout_pattern', 'other'];

export const FRONT_TYPES = ['door', 'drawer', 'false_front', 'open'];

const str = { type: 'string' };
const num = { type: 'number' };
const int = { type: 'integer' };
const bool = { type: 'boolean' };
// where something sits in the photo, as fractions of the photo's width and height from its top-left corner
const obj = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });

const box = () => obj({ left: num, top: num, right: num, bottom: num });

const SCHEMA = obj({
  summary: str,
  scale_basis: str,
  style: obj({
    door_style: str, construction: { type: 'string', enum: ['face_frame', 'frameless', 'unknown'] },
    door_overlay: { type: 'string', enum: ['full_overlay', 'partial_overlay', 'inset', 'unknown'] },
    toe_kick: str, crown: str, light_rail: str, fillers: str, end_panels: str, countertop: str,
    hardware: str, finish: str, other: str,
  }),
  cabinets: {
    type: 'array',
    items: obj({
      position: int,
      row: { type: 'string', enum: ['base', 'wall', 'tall'] },
      type: { type: 'string', enum: CABINET_TYPES },
      width_in: num, height_in: num, depth_in: num,
      width_measured: bool, height_measured: bool, depth_measured: bool,
      doors: int, drawers: int,
      layout: str, hinge: str, notes: str,
      confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
      box_in_photo: box(),
      fronts: { type: 'array', items: obj({ kind: { type: 'string', enum: FRONT_TYPES }, width_in: num, height_in: num, hinge: str, box_in_photo: box() }) },
    }),
  },
  decorative_parts: { type: 'array', items: obj({ kind: { type: 'string', enum: DECOR_TYPES }, description: str, location: str, box_in_photo: box() }) },
  warnings: { type: 'array', items: str },
});

const PROMPT = (known) => `You are helping a cabinet maker copy a run of cabinets from a photo so they can enter it in Mozaik (cabinet design software) and cut it on a CNC.

Identify every cabinet box in the photo, left to right. Put base and tall cabinets in order along the floor, and wall cabinets in order along the wall (give every box a "position" counting left to right across the whole run, wall boxes numbered after the base/tall boxes they sit over is fine as long as left-to-right order holds within each row).

For each box estimate width, height and depth in inches. Scale:
${known ? `- The user measured: ${known}. Scale everything from that. Mark that dimension as measured (true); everything else is estimated (false).` : '- No measurement was given. Use standard sizes to set scale: base cabinet box height 34 1/2" (36" to the countertop), base depth 24", wall depth 12", tall depth 24".'}
- Standard cabinet widths come in 3" steps (9, 12, 15, 18, 21, 24, 27, 30, 33, 36...). Give your best estimate; the app rounds it.
- Mark a dimension "measured": true only if it comes straight from the user's measurement.

For each box give: door count, drawer count, a short layout description (for example "1 drawer over 2 doors", "4 drawers", "2 doors, 1 adjustable shelf visible"), hinge side for single doors if visible, and anything unusual in notes. Include fillers, end panels and appliance openings as their own entries when they take up width in the run.

Fronts: for every box, list each door and drawer front you can see in "fronts", top to bottom, then left to right within a row. kind is door, drawer, false_front (a fixed panel that looks like a drawer, e.g. in front of a sink) or open (an opening with no front). Give each front's width and height in inches on the same scale as the boxes, the hinge side for doors if you can tell (left or right, from the front; leave empty otherwise), and its own box_in_photo covering just that front. The number of door and drawer fronts must match the box's door and drawer counts.

Style: door style (shaker, slab, raised panel, recessed panel, beadboard, glass, etc.), face frame or frameless, overlay, toe kick, crown, light rail, fillers, end panels, countertop, hardware, finish, and anything else worth knowing.

For every box and every decorative part, give box_in_photo: the rectangle it occupies in the photo, as fractions of the photo's width and height measured from the top-left corner (left and right from 0 to 1 across, top and bottom from 0 to 1 down). The cabinet maker uses these rectangles to check, on the photo, that nothing was missed or counted twice, so make each one cover that box's face and nothing else.

Decorative parts: list valances, corbels, brackets, arched or cathedral door tops, decorative end panels, appliqués or cutout patterns. These will be traced separately into DXF files.

In scale_basis say what you scaled from. In warnings, list anything hidden, cut off, or too uncertain to estimate. Be honest about uncertainty: use low confidence where the photo doesn't show enough.`;

export async function analyzeCabinets({ apiKey, model, imageBase64, mediaType = 'image/jpeg', known }) {
  return callJSON({
    apiKey, model, schema: SCHEMA,
    content: [
      { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
      { type: 'text', text: PROMPT(known) },
    ],
    errors: { refusal: 'Claude declined to analyze this photo. Try a different photo.', cut: 'The answer was cut off. Try a photo with fewer cabinets.' },
  });
}

// One request whose answer must match `schema`. Returns the parsed JSON.
async function callJSON({ apiKey, model, content, schema, errors }) {
  if (!apiKey) throw new Error('Add your Claude API key in Settings first.');
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true, timeout: 5 * 60 * 1000, maxRetries: 2 });
  const body = {
    model,
    max_tokens: 16000,
    output_config: { effort: 'high', format: { type: 'json_schema', schema } },
    messages: [{ role: 'user', content }],
  };
  let msg;
  try {
    // If Claude declines for safety reasons, the API retries on a fallback model by itself.
    msg = await client.beta.messages.create({ ...body, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
  } catch (e) {
    if (e instanceof Anthropic.BadRequestError && /fallback|beta/i.test(e.message || '')) {
      try { msg = await client.messages.create(body); } catch (e2) { throw friendly(e2); }
    } else throw friendly(e);
  }
  if (msg.stop_reason === 'refusal') throw new Error(errors.refusal);
  if (msg.stop_reason === 'max_tokens') throw new Error(errors.cut);
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Claude’s answer could not be read. Try again.');
  }
}

// ---------------------------------------------------------------- Mode 1: "Suggest details"

export const DETAILS_MODEL = 'claude-sonnet-5-5';
const CUT_IDS = ['inside', 'pocket', 'groove', 'profile', 'skip'];
const BIT_IDS = ['none', 'v90', 'v60', 'v120', 'ball0.125', 'ball0.25', 'str0.125', 'str0.25',
  'rp_cove', 'rp_ogee', 'rp_bevel', 'ro0.25', 'ro0.375', 'ro0.5', 'ogee', 'roman', 'cove', 'chamfer', 'bead', 'other'];
const pt = obj({ x: num, y: num });
const DETAILS_SCHEMA = obj({
  summary: str,
  shapes: { type: 'array', items: obj({
    id: int, cut: { type: 'string', enum: CUT_IDS }, depth_in: num, bit: { type: 'string', enum: BIT_IDS },
    description: str, confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
  }) },
  missing: { type: 'array', items: obj({
    description: str, cut: { type: 'string', enum: CUT_IDS }, closed: bool, depth_in: num, bit: { type: 'string', enum: BIT_IDS },
    points_in: { type: 'array', items: pt },
  }) },
  warnings: { type: 'array', items: str },
});

const DETAILS_PROMPT = ({ widthIn, heightIn, shapes }) => `This is a straightened photo of a cabinet part (a door, drawer front or panel) that a cabinet maker will cut on a CNC router. The picture is ${widthIn.toFixed(2)}" wide and ${heightIn.toFixed(2)}" tall (scale is uniform; x to the right, y down, from the top-left corner of the picture).

The app has already found the part's outer outline and some details inside it, drawn as colored outlines with numbered tags:
${shapes.length ? shapes.map((s) => `- #${s.id}: ${s.closed ? 'closed shape' : 'open line'}, about ${s.w.toFixed(1)}" x ${s.h.toFixed(1)}", top-left near (${s.x.toFixed(1)}, ${s.y.toFixed(1)}), currently marked "${s.cut}"`).join('\n') : '- (none found yet)'}

Cut types:
- inside: cut all the way through (glass opening, cutout)
- pocket: flat-bottomed recess
- groove: a cut along the line (V-groove, carved or fluted line, ball-nose groove)
- profile: the line where an edge profile goes (e.g. the outline of a raised panel, cut with a raised-panel bit; a roundover)
- skip: not a separate cut (for example the flat field of a raised panel, which the raised-panel bit leaves behind; or a shadow, a grain line or a reflection the app mistook for a feature)

For each numbered shape, say what it is and how it is most likely cut. Give a depth guess in inches for pocket and groove (0 for the others) and the likely bit (use "none" if no bit applies). A photo can't show depth, so depths are guesses: keep them typical (1/8" to 1/4" for grooves, 1/4" for pockets) unless the photo shows clearly otherwise.

Then list decorative features that are clearly visible but have no numbered outline yet ("missing"). For each give its outline as points in inches from the picture's top-left corner (enough points to follow curves, 4 to 40), whether it is a closed shape or an open line, and its likely cut. Only include features you can actually see; leave "missing" empty if there are none. Your points are rough; the user will check and adjust them.

In summary, describe the part in one or two sentences. Put anything uncertain in warnings.`;

// imageBase64: JPEG of the part (straightened, with the numbered outlines drawn on it).
// shapes: [{ id, closed, cut, x, y, w, h }] in inches from the picture's top-left.
export async function suggestDetails({ apiKey, imageBase64, widthIn, heightIn, shapes }) {
  return callJSON({
    apiKey, model: DETAILS_MODEL, schema: DETAILS_SCHEMA,
    content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
      { type: 'text', text: DETAILS_PROMPT({ widthIn, heightIn, shapes }) },
    ],
    errors: { refusal: 'Claude declined to look at this photo.', cut: 'Claude’s answer was cut off. Try again with fewer shapes.' },
  });
}

// ---------------------------------------------------------------- Mode 1: find the part in a photo

const LOCATE_SCHEMA = obj({
  found: bool,
  part: str,
  rectangular: bool,
  corners: { type: 'array', items: pt },
  inside_point: pt,
  summary: str,
  warnings: { type: 'array', items: str },
});

const LOCATE_PROMPT = ({ widthIn, heightIn, hint }) => `A cabinet maker photographed one cabinet part (a door, drawer front, panel, valance, corbel, bracket or similar) to copy it on a CNC router. They measured it: ${widthIn}" wide and ${heightIn}" tall overall.${hint ? `\n\nWhat to look for: ${hint}` : ''}

Find that part in the photo and give:
- corners: the 4 corners of the part's overall rectangle as it appears in the photo, in this order: top-left, top-right, bottom-right, bottom-left. For a rectangular part (most doors and panels) these are the part's own corners, exactly on its outer edge. For a shaped part (an arched valance, a corbel), they are the corners of the smallest rectangle that encloses it, drawn in the plane of the part so they follow the photo's perspective.
- rectangular: true if the part's outline is a plain rectangle (rounded or profiled edges are still rectangular), false if the outline itself is shaped (arched top, scalloped bottom, curved corbel).
- inside_point: a point clearly on the part itself, away from its edges.
- part: what the part is, in a few words.

Coordinates are fractions of the photo's width (x, 0 at the left, 1 at the right) and height (y, 0 at the top, 1 at the bottom). Be as exact as you can about the corners: the app straightens the photo with them, and it refines them on the part's edges afterwards.
If you can't find a part that fits, set found to false and say why in warnings. Put anything else uncertain in warnings; in summary describe the part and its visible details in one or two sentences.`;

// Finds the part in the photo. Returns { found, part, rectangular, corners: [{x,y}] fractions, inside_point, summary, warnings }.
export async function locatePart({ apiKey, model, imageBase64, widthIn, heightIn, hint }) {
  return callJSON({
    apiKey, model, schema: LOCATE_SCHEMA,
    content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
      { type: 'text', text: LOCATE_PROMPT({ widthIn, heightIn, hint }) },
    ],
    errors: { refusal: 'Claude declined to look at this photo.', cut: 'Claude’s answer was cut off. Try again.' },
  });
}

function friendly(e) {
  if (e instanceof Anthropic.AuthenticationError) return new Error('The API key was rejected. Check it in Settings.');
  if (e instanceof Anthropic.PermissionDeniedError) return new Error('This API key is not allowed to use that model. Pick another model in Settings.');
  if (e instanceof Anthropic.NotFoundError) return new Error('Model not found. Pick another model in Settings.');
  if (e instanceof Anthropic.RateLimitError) return new Error('Too many requests right now. Wait a minute and try again.');
  if (e instanceof Anthropic.APIConnectionError) return new Error('Could not reach Claude. Check your internet connection.');
  if (e instanceof Anthropic.APIError) return new Error(`Claude API error ${e.status || ''}: ${e.message}`);
  return e;
}
