//! KasiTek's direct-product modular monolith.
//!
//! Transport adapters live under `api`, shared product behaviour migrates into
//! `domains`, and the application composition root lives under `bootstrap`.
//! Existing controller/service modules remain available while their behaviour
//! is incrementally moved behind domain commands and queries.

pub mod api;
pub mod bootstrap;
pub mod capabilities;
pub mod config;
pub mod controllers;
pub mod db;
pub mod domains;
pub mod error;
pub mod identity;
pub mod middleware;
pub mod routes;
pub mod services;
pub mod workers;
