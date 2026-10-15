import { useNavigate } from "react-router";

/**
 * Survey switcher for pages that show one survey at a time.
 *
 * A select rather than a row of buttons: survey names are merchant text of any
 * length, and a row of them ran off the edge of the card on a phone. The choice
 * is kept in the URL (`?survey=`), so it survives a refresh and the back button.
 */
export function SurveyPicker({
  surveys,
  selected,
  basePath,
  label,
  query = {},
}: {
  surveys: ReadonlyArray<{ id: string; name: string }>;
  selected: string | null;
  basePath: string;
  label: string;
  /** Other parameters to keep when switching survey, such as the date range. */
  query?: Record<string, string>;
}) {
  const navigate = useNavigate();
  if (surveys.length < 2) return null;

  return (
    <s-box maxInlineSize="100%">
      <s-select
        label={label}
        value={selected ?? undefined}
        onChange={(event) => {
          const next = (event.currentTarget as { value?: unknown }).value;
          if (typeof next === "string" && next !== selected) {
            const params = new URLSearchParams({ ...query, survey: next });
            navigate(`${basePath}?${params.toString()}`);
          }
        }}
      >
        {surveys.map((survey) => (
          <s-option key={survey.id} value={survey.id} selected={survey.id === selected}>
            {survey.name}
          </s-option>
        ))}
      </s-select>
    </s-box>
  );
}
