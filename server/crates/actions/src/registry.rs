use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};

use jsonschema::Validator;
use serde_json::Value;

use crate::{
    schema::{compile_schema, validate_instance},
    ActionDefinition, ActionError, ActionId, ActionLifecycle, ActorKind, IncomingActionRequest,
    ProductRuntime, SchemaSide, ValidatedActionRequest,
};

#[derive(Clone, Copy, Debug)]
pub struct RegistryFilter<'a> {
    pub runtime: ProductRuntime,
    pub actor: ActorKind,
    pub lifecycle: Option<ActionLifecycle>,
    pub grants: &'a BTreeSet<String>,
}

#[derive(Clone)]
pub struct RegisteredAction {
    definition: Arc<ActionDefinition>,
    input_validator: Arc<Validator>,
    output_validator: Arc<Validator>,
}

impl std::fmt::Debug for RegisteredAction {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("RegisteredAction")
            .field("definition", &self.definition)
            .finish_non_exhaustive()
    }
}

impl RegisteredAction {
    fn compile(definition: ActionDefinition) -> Result<Self, ActionError> {
        definition.validate_metadata()?;
        let input_validator = compile_schema(SchemaSide::Input, &definition.input_schema)?;
        let output_validator = compile_schema(SchemaSide::Output, &definition.output_schema)?;
        Ok(Self {
            definition: Arc::new(definition),
            input_validator: Arc::new(input_validator),
            output_validator: Arc::new(output_validator),
        })
    }

    pub fn definition(&self) -> &ActionDefinition {
        &self.definition
    }

    pub fn validate_input(&self, input: &Value) -> Result<(), ActionError> {
        validate_instance(SchemaSide::Input, &self.input_validator, input)
    }

    pub fn validate_output(&self, output: &Value) -> Result<(), ActionError> {
        validate_instance(SchemaSide::Output, &self.output_validator, output)
    }
}

#[derive(Debug, Default)]
pub struct ActionRegistry {
    actions: BTreeMap<ActionId, RegisteredAction>,
}

impl ActionRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn from_definitions(
        definitions: impl IntoIterator<Item = ActionDefinition>,
    ) -> Result<Self, ActionError> {
        let mut registry = Self::new();
        for definition in definitions {
            registry.register(definition)?;
        }
        Ok(registry)
    }

    pub fn register(&mut self, definition: ActionDefinition) -> Result<(), ActionError> {
        let id = definition.id.clone();
        if self.actions.contains_key(&id) {
            return Err(ActionError::DuplicateAction(id.to_string()));
        }
        let action = RegisteredAction::compile(definition)?;
        self.actions.insert(id, action);
        Ok(())
    }

    pub fn get(&self, id: &ActionId) -> Result<&RegisteredAction, ActionError> {
        self.actions
            .get(id)
            .ok_or_else(|| ActionError::ActionNotFound(id.to_string()))
    }

    pub fn definitions(&self) -> impl Iterator<Item = &ActionDefinition> {
        self.actions.values().map(RegisteredAction::definition)
    }

    pub fn discoverable_definitions<'a>(
        &'a self,
        filter: RegistryFilter<'a>,
    ) -> impl Iterator<Item = &'a ActionDefinition> + 'a {
        self.definitions().filter(move |definition| {
            definition.supported_runtimes.contains(&filter.runtime)
                && definition.supported_actors.contains(&filter.actor)
                && filter
                    .lifecycle
                    .is_none_or(|lifecycle| definition.lifecycle == lifecycle)
                && definition.required_grants.is_subset(filter.grants)
        })
    }

    pub fn validate_request(
        &self,
        request: IncomingActionRequest,
    ) -> Result<ValidatedActionRequest, ActionError> {
        let action = self.get(&request.action)?;
        ValidatedActionRequest::new(request, action)
    }

    pub fn validate_output(&self, id: &ActionId, output: &Value) -> Result<(), ActionError> {
        self.get(id)?.validate_output(output)
    }
}
