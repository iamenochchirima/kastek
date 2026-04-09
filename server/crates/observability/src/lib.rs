use env_logger::Env;

pub fn init(default_filter: &str) {
    env_logger::init_from_env(Env::default().default_filter_or(default_filter));
}
