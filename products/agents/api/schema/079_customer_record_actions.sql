ALTER TABLE agents_platform.enquiries ADD COLUMN amends_enquiry_id uuid;
ALTER TABLE agents_platform.enquiries ADD CONSTRAINT enquiry_amendment_tenant FOREIGN KEY(organization_id,amends_enquiry_id) REFERENCES agents_platform.enquiries(organization_id,id);
CREATE UNIQUE INDEX enquiry_one_confirmed_amendment ON agents_platform.enquiries(organization_id,amends_enquiry_id) WHERE amends_enquiry_id IS NOT NULL AND state='submitted';
