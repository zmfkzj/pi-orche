const processed = new Set();
export function onOrderPlaced(event, handle) {
  if (processed.has(event.idempotencyKey)) return;
  processed.add(event.idempotencyKey);
  handle(event.order);
}
