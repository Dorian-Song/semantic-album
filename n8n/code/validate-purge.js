// Album enrichment purge — the backend asks to delete the rows of a photo that left the library.
// Runs once for each item. Input: the webhook body {assetId}.
const assetId = $json.body?.assetId;
if (typeof assetId !== 'string' || !/^[\w-]{1,64}$/.test(assetId)) {
  throw new Error('assetId must be an ID string');
}
return { json: { assetId } };
