// Album enrichment — validate and normalise one photo description sent by the Album backend.
// Runs once for each item. Input: the webhook body {assetId, taskId, revision, caption, tags}.
// Output: {valid: false, error} or {valid: true, row}, where row is the Data Table record.
// Only text and IDs arrive here; photos never leave the user's computer.

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'have', 'in', 'into', 'is', 'it', 'its',
  'of', 'on', 'or', 'over', 'the', 'their', 'there', 'this', 'that', 'to', 'under', 'with', 'while', 'near',
  'appears', 'visible', 'shows', 'showing', 'image', 'photo', 'picture', 'features', 'featuring', 'some', 'two',
  'three', 'one', 'several', 'large', 'small', 'background', 'foreground', 'left', 'right', 'side',
]);

// Broad categories derived from tags and caption words, so "animals" finds a photo tagged "dog".
const CATEGORIES = {
  people: ['person', 'people', 'man', 'men', 'woman', 'women', 'child', 'children', 'boy', 'girl', 'baby', 'crowd', 'family', 'portrait', 'player', 'players'],
  animals: ['dog', 'dogs', 'cat', 'cats', 'bird', 'birds', 'horse', 'horses', 'cow', 'cows', 'sheep', 'elephant', 'elephants', 'bear', 'zebra', 'giraffe', 'giraffes', 'animal', 'animals', 'pet', 'puppy', 'kitten'],
  food: ['food', 'pizza', 'sandwich', 'cake', 'donut', 'donuts', 'fruit', 'banana', 'bananas', 'apple', 'orange', 'broccoli', 'carrot', 'meal', 'dish', 'plate', 'bread', 'coffee', 'dessert', 'breakfast', 'dinner', 'lunch', 'vegetables'],
  nature: ['tree', 'trees', 'forest', 'mountain', 'mountains', 'beach', 'sea', 'ocean', 'lake', 'river', 'field', 'grass', 'flower', 'flowers', 'sky', 'sunset', 'sunrise', 'snow', 'hill', 'hills', 'landscape', 'garden', 'park'],
  city: ['street', 'road', 'city', 'building', 'buildings', 'traffic', 'sidewalk', 'downtown', 'urban', 'bridge', 'crosswalk', 'intersection'],
  indoor: ['room', 'kitchen', 'bedroom', 'bathroom', 'living', 'office', 'table', 'desk', 'couch', 'sofa', 'bed', 'indoor', 'indoors', 'restaurant'],
  vehicles: ['car', 'cars', 'bus', 'truck', 'train', 'motorcycle', 'bicycle', 'bike', 'boat', 'airplane', 'plane', 'vehicle', 'vehicles', 'tram'],
  sports: ['sport', 'sports', 'tennis', 'baseball', 'soccer', 'football', 'skateboard', 'skateboarding', 'surfing', 'surfboard', 'skiing', 'ski', 'snowboard', 'frisbee', 'kite', 'game', 'match'],
  text: ['text', 'sign', 'signs', 'writing', 'label', 'poster', 'banner', 'reads', 'reading', 'words'],
  // "dark" and "lights" are left out: captions use them for colours and lamps far more than for night scenes.
  night: ['night', 'nighttime', 'evening', 'neon', 'moonlight', 'starry'],
};

const body = $json.body ?? {};
const fail = (error) => ({ json: { valid: false, error } });

if (typeof body.assetId !== 'string' || !/^[\w-]{1,64}$/.test(body.assetId)) return fail('assetId must be an ID string');
if (!Number.isInteger(body.revision) || body.revision < 1) return fail('revision must be a positive integer');
if (typeof body.caption !== 'string' || body.caption.trim() === '') return fail('caption must be a non-empty string');
if (body.caption.length > 2000) return fail('caption is longer than 2000 characters');
if (body.tags !== undefined && !Array.isArray(body.tags)) return fail('tags must be an array of strings');

let caption = body.caption.replace(/\s+/g, ' ').trim();
caption = caption.charAt(0).toUpperCase() + caption.slice(1);
if (!/[.!?"')]$/.test(caption)) caption += '.';

const tags = [
  ...new Set(
    (body.tags ?? [])
      .filter((t) => typeof t === 'string')
      .map((t) => t.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, ' ').trim())
      .filter((t) => t.length > 0 && t.length <= 40 && !STOP_WORDS.has(t)),
  ),
].slice(0, 15);

const words = caption.toLowerCase().match(/\p{L}[\p{L}'-]*/gu) ?? [];
const keywords = [...new Set(words.filter((w) => w.length >= 3 && !STOP_WORDS.has(w) && !tags.includes(w)))].slice(0, 12);
const vocabulary = new Set([...tags.flatMap((t) => t.split(' ')), ...words]);
const categories = Object.entries(CATEGORIES)
  .filter(([, members]) => members.some((m) => vocabulary.has(m)))
  .map(([name]) => name);

return {
  json: {
    valid: true,
    row: {
      key: `${body.assetId}:${body.revision}`,
      assetId: body.assetId,
      revision: body.revision,
      caption,
      tags: tags.join(', '),
      keywords: keywords.join(', '),
      categories: categories.join(', '),
      wordCount: words.length,
    },
  },
};
