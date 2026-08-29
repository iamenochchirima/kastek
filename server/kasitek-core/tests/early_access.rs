use kasitek_core::services::early_access::{
    COHORT_BETA, STATUS_ACTIVE, STATUS_APPROVED, STATUS_INVITED, STATUS_NEW, STATUS_REJECTED,
};

#[test]
fn self_service_lifecycle_uses_direct_approval_and_activation_states() {
    assert_eq!(STATUS_NEW, "new");
    assert_eq!(STATUS_APPROVED, "approved");
    assert_eq!(STATUS_INVITED, "invited");
    assert_eq!(STATUS_ACTIVE, "active");
    assert_eq!(STATUS_REJECTED, "rejected");
    assert_eq!(COHORT_BETA, "beta");
}
