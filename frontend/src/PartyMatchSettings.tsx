import { useState } from "react";
import type { MatchSettings } from "./roomProtocol";

export default function PartyMatchSettings({
  settings,
  disabled,
  onSave,
}: {
  settings: MatchSettings;
  disabled: boolean;
  onSave: (settings: MatchSettings) => void;
}) {
  const [rounds, setRounds] = useState(String(settings.roundCount));
  const [period, setPeriod] = useState(
    settings.archiveYear === null
      ? String(settings.rangeDays)
      : `year:${settings.archiveYear}`,
  );
  const year = new Date().getUTCFullYear();
  const years = [
    ...new Set([
      year,
      year - 1,
      year - 2,
      year - 3,
      ...(settings.archiveYear === null ? [] : [settings.archiveYear]),
    ]),
  ];
  return (
    <form
      className="party-form party-fresh-options"
      onSubmit={(event) => {
        event.preventDefault();
        onSave({
          ...settings,
          roundCount: Number(rounds),
          archiveYear: period.startsWith("year:")
            ? Number(period.slice(5))
            : null,
          rangeDays: period.startsWith("year:") ? null : Number(period),
        });
      }}
    >
      <fieldset disabled={disabled} className="party-options">
        <legend>Find fresh questions</legend>
        <label>
          Rounds
          <select
            value={rounds}
            onChange={(event) => setRounds(event.target.value)}
          >
            <option value="5">5 rounds</option>
            <option value="10">10 rounds</option>
            <option value="20">20 rounds</option>
          </select>
        </label>
        <label>
          Archive period
          <select
            value={period}
            onChange={(event) => setPeriod(event.target.value)}
          >
            {years.map((value) => (
              <option key={value} value={`year:${value}`}>
                {value}
              </option>
            ))}
            <option value="30">Last 30 days</option>
            <option value="90">Last 3 months</option>
          </select>
        </label>
        <button className="party-secondary" type="submit">
          Apply match settings
        </button>
      </fieldset>
    </form>
  );
}
