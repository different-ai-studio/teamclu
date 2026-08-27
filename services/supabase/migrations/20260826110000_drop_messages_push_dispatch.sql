-- Push dispatch is owned by FC: insertMessage calls dispatchPush inline after
-- the row is written. The DB webhook (notify_push_dispatch → /push/dispatch)
-- required vault secrets that were easy to omit and duplicated the FC path.

DROP TRIGGER IF EXISTS messages_push_dispatch ON amux.messages;
DROP FUNCTION IF EXISTS amux.notify_push_dispatch();
