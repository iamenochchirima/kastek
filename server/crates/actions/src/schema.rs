use jsonschema::Validator;
use serde_json::Value;

use crate::{ActionError, SchemaSide};

pub(crate) fn compile_schema(side: SchemaSide, schema: &Value) -> Result<Validator, ActionError> {
    ensure_object_schema(side, schema)?;
    jsonschema::draft202012::meta::validate(schema).map_err(|error| {
        ActionError::InvalidSchema {
            side,
            detail: error.to_string(),
        }
    })?;
    jsonschema::draft202012::new(schema).map_err(|error| ActionError::InvalidSchema {
        side,
        detail: error.to_string(),
    })
}

fn ensure_object_schema(side: SchemaSide, schema: &Value) -> Result<(), ActionError> {
    if schema.get("type").and_then(Value::as_str) != Some("object") {
        return Err(ActionError::InvalidSchema {
            side,
            detail: "top-level action schemas must declare type object".to_string(),
        });
    }
    Ok(())
}

pub(crate) fn validate_instance(
    side: SchemaSide,
    validator: &Validator,
    instance: &Value,
) -> Result<(), ActionError> {
    validator.validate(instance).map_err(|error| {
        let instance_path = error.instance_path().as_str();
        ActionError::SchemaViolation {
            side,
            instance_path: if instance_path.is_empty() {
                "/".to_string()
            } else {
                instance_path.to_string()
            },
        }
    })
}
