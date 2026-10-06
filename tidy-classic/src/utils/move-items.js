/**
 * Move each source only after its replacement was created or a transfer into an
 * existing target was confirmed. A dialog or rejected transform is not a
 * completed transfer, so the source must remain untouched.
 */
export async function createMovedItems(items, createOne, deleteSource) {
  const created = [];
  for (const item of items) {
    const { documents = [], transferred = false } = await createOne(item);
    if (!documents.length && !transferred) continue;
    created.push(...documents);
    await deleteSource(item);
  }
  return created;
}
