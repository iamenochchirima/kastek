import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { PageHeader } from "../components";
import {
  agentConfigFields,
  agentConfigGroups,
  agentConfigStatusLabel,
  agentConfigTypes,
  type AgentConfigStatus,
} from "../data/agent-config-catalogue";
import "../agent-configuration.css";

const statusSymbol: Record<AgentConfigStatus, string> = {
  required: "●",
  optional: "○",
  na: "—",
  deferred: "D",
};

export default function AgentConfigurationPage() {
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState("all");

  const visibleFields = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return agentConfigFields.filter((field) => {
      if (group !== "all" && field.group !== group) return false;
      if (!normalized) return true;
      return [field.field, field.group, field.summary, field.input, field.example, field.where]
        .join(" ")
        .toLowerCase()
        .includes(normalized);
    });
  }, [group, query]);

  const visibleGroups = useMemo(
    () => agentConfigGroups.filter((name) => visibleFields.some((field) => field.group === name)),
    [visibleFields],
  );

  return (
    <div className="agent-catalogue-page">
      <PageHeader
        eyebrow="Evals"
        title="Agent configuration"
        description="The fields a user can configure on a sandbox agent, and which ones apply to each template archetype. Use this catalogue to define templates and dataset cases."
        actions={<Link className="button ghost" to="/">Sandboxes</Link>}
      />

      <div className="agent-catalogue-toolbar">
        <input
          className="input agent-catalogue-search"
          aria-label="Search configuration fields"
          placeholder="Search field, group or description…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <label className="agent-catalogue-filter">
          <span>Group</span>
          <select className="select" value={group} onChange={(event) => setGroup(event.target.value)}>
            <option value="all">All groups</option>
            {agentConfigGroups.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </label>
        <span className="agent-catalogue-count">{visibleFields.length} of {agentConfigFields.length} fields</span>
      </div>

      <div className="agent-catalogue-legend">
        {(["required", "optional", "na", "deferred"] as const).map((status) => (
          <span key={status}>
            <b className={`agent-catalogue-symbol status-${status}`}>{statusSymbol[status]}</b>
            {agentConfigStatusLabel[status]}
          </span>
        ))}
      </div>

      <div className="agent-catalogue-table-wrap">
        <table className="agent-catalogue-table">
          <thead>
            <tr>
              <th scope="col" className="agent-catalogue-field-col">Field</th>
              <th scope="col" className="agent-catalogue-summary-col">What it controls</th>
              <th scope="col">Input / values</th>
              <th scope="col">Required</th>
              <th scope="col">Example</th>
              <th scope="col">Where in Agents</th>
              {agentConfigTypes.map((type) => (
                <th scope="col" key={type.key} className="agent-catalogue-type-col">{type.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visibleGroups.map((groupName) => {
              const fields = visibleFields.filter((field) => field.group === groupName);
              return (
                <GroupRows key={groupName} group={groupName} fields={fields} />
              );
            })}
          </tbody>
        </table>
        {visibleFields.length === 0 ? (
          <div className="agent-catalogue-empty">
            <span>No matching fields</span>
            <button className="button ghost" type="button" onClick={() => { setQuery(""); setGroup("all"); }}>Clear filters</button>
          </div>
        ) : null}
      </div>

      <p className="agent-catalogue-note">
        <strong>Agent types are template archetypes, not separate product offerings.</strong> Customer
        service is one offering; Answering, Handoff, Booking, Enquiry and Full service are responsibility
        presets. Research and Custom are generic agents; Assistant is built in.
      </p>
      <p className="agent-catalogue-note">
        <strong>Excluded from this catalogue:</strong> avatar, retrieval profile, program/version,
        execution kind, model token limits, context compaction, knowledge visibility, sandbox,
        workflows, product bindings, capability policy IDs/digests, schedules and published version.
        Those remain internal or advanced/API settings.
      </p>
      <p className="agent-catalogue-note">
        Channels are marked deferred because the evaluation sandbox does not copy channel credentials
        or customer data. The product can still deploy agents to channels.
      </p>
    </div>
  );
}

function GroupRows({
  group,
  fields,
}: {
  group: string;
  fields: typeof agentConfigFields;
}) {
  return (
    <>
      <tr className="agent-catalogue-group-row">
        <th scope="colgroup" colSpan={6 + agentConfigTypes.length}>{group}</th>
      </tr>
      {fields.map((field) => (
        <tr key={field.field}>
          <th scope="row" className="agent-catalogue-field-col">{field.field}</th>
          <td className="agent-catalogue-summary-col">{field.summary}</td>
          <td>{field.input}</td>
          <td>{field.required}</td>
          <td>{field.example}</td>
          <td>{field.where}</td>
          {agentConfigTypes.map((type) => {
            const status = field.status[type.key];
            return (
              <td
                key={type.key}
                className={`agent-catalogue-type-cell status-${status}`}
                title={agentConfigStatusLabel[status]}
                aria-label={agentConfigStatusLabel[status]}
              >
                {statusSymbol[status]}
              </td>
            );
          })}
        </tr>
      ))}
    </>
  );
}
