-- opt_out now triggers the same delete-and-queue-for-replacement flow as a
-- hard bounce or departed contact: they explicitly asked not to be
-- contacted again, suppression already guarantees that regardless of
-- whether the contact record exists, and the venue itself may still be
-- worth a fresh pitch to someone else later.
alter table replacement_queue drop constraint replacement_queue_reason_check;
alter table replacement_queue add constraint replacement_queue_reason_check
  check (removed_reason in ('bounce', 'ooo_departed', 'opt_out'));
