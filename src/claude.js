// Mode 2 image analysis with Claude, called straight from the phone's browser with the key saved in Settings.
import Anthropic from '@anthropic-ai/sdk';

export const CABINET_TYPES = [
  'base', 'sink_base', 'drawer_base', 'corner_base', 'blind_corner_base', 'wall', 'corner_wall', 'tall', 'pantry',
  'oven_tall', 'vanity', 'open_shelf', 'appliance_opening', 'filler', 'end_panel', 'other',
];
export const DECOR_TYPES = ['valance', 'corbel', 'bracket', 'arched_door_top', 'decorative_end_panel', 'applied_molding', 'cutout_pattern', 'other'];

const str = { type: 'string' };
const num = { type: 'number' };
const int = { type: 'integer' };
const bool = { type: 'boolean' };
const obj = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });

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
    }),
  },
  decorative_parts: { type: 'array', items: obj({ kind: { type: 'string', enum: DECOR_TYPES }, description: str, location: str }) },
  warnings: { type: 'array', items: str },
});

const PROMPT = (known) => `You are helping a cabinet maker copy a run of cabinets from a photo so they can enter it in Mozaik (cabinet design software) and cut it on a CNC.

Identify every cabinet box in the photo, left to right. Put base and tall cabinets in order along the floor, and wall cabinets in order along the wall (give every box a "position" counting left to right across the whole run, wall boxes numbered after the base/tall boxes they sit over is fine as long as left-to-right order holds within each row).

For each box estimate width, height and depth in inches. Scale:
${known ? `- The user measured: ${known}. Scale everything from that. Mark that dimension as measured (true); everything else is estimated (false).` : '- No measurement was given. Use standard sizes to set scale: base cabinet box height 34 1/2" (36" to the countertop), base depth 24", wall depth 12", tall depth 24".'}
- Standard cabinet widths come in 3" steps (9, 12, 15, 18, 21, 24, 27, 30, 33, 36...). Give your best estimate; the app rounds it.
- Mark a dimension "measured": true only if it comes straight from the user's measurement.

For each box give: door count, drawer count, a short layout description (for example "1 drawer over 2 doors", "4 drawers", "2 doors, 1 adjustable shelf visible"), hinge side for single doors if visible, and anything unusual in notes. Include fillers, end panels and appliance openings as their own entries when they take up width in the run.

Style: door style (shaker, slab, raised panel, recessed panel, beadboard, glass, etc.), face frame or frameless, overlay, toe kick, crown, light rail, fillers, end panels, countertop, hardware, finish, and anything else worth knowing.

Decorative parts: list valances, corbels, brackets, arched or cathedral door tops, decorative end panels, appliqués or cutout patterns. These will be traced separately into DXF files.

In scale_basis say what you scaled from. In warnings, list anything hidden, cut off, or too uncertain to estimate. Be honest about uncertainty: use low confidence where the photo doesn't show enough.`;

export async function analyzeCabinets({ apiKey, model, imageBase64, mediaType = 'image/jpeg', known }) {
  if (!apiKey) throw new Error('Add your Claude API key in Settings first.');
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true, timeout: 5 * 60 * 1000, maxRetries: 2 });
  const body = {
    model,
    max_tokens: 16000,
    output_config: { effort: 'high', format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
        { type: 'text', text: PROMPT(known) },
      ],
    }],
  };
  let msg;
  try {
    // If Claude declines for safety reasons, the API retries on a fallback model by itself.
    msg = await client.beta.messages.create({ ...body, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
  } catch (e) {
    if (e instanceof Anthropic.BadRequestError && /fallback|beta/i.test(e.message || '')) msg = await client.messages.create(body);
    else throw friendly(e);
  }
  if (msg.stop_reason === 'refusal') throw new Error('Claude declined to analyze this photo. Try a different photo.');
  if (msg.stop_reason === 'max_tokens') throw new Error('The answer was cut off. Try a photo with fewer cabinets.');
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Claude’s answer could not be read. Try again.');
  }
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
