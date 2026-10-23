CREATE TABLE operations_worker_heartbeats (
 worker TEXT NOT NULL,
 instance TEXT NOT NULL,
 environment TEXT NOT NULL,
 observed_at TIMESTAMPTZ NOT NULL,
 PRIMARY KEY(worker,instance,environment)
);
