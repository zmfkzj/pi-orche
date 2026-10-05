# Order events

When an order is placed we write it to the database and publish `order.placed` to the broker. Every event carries an idempotency key (the order id), so delivery is **exactly-once**: consumers never miss an event and never see one twice.
