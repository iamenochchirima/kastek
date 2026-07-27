mod conversations;
mod customers;

use crate::{ActionDefinition, ActionError, ActionRegistry};

pub use conversations::{conversation_draft_reply, conversation_get_summary};
pub use customers::customer_search;

pub fn initial_definitions() -> Vec<ActionDefinition> {
    vec![
        customer_search(),
        conversation_get_summary(),
        conversation_draft_reply(),
    ]
}

pub fn initial_registry() -> Result<ActionRegistry, ActionError> {
    ActionRegistry::from_definitions(initial_definitions())
}
