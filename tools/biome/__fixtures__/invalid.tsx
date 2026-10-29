// Every case here must be flagged by no-literal-ui-string (SPEC §11.6). Snapshot: snapshot.txt.
declare const n: number;
declare const ok: boolean;
declare const name: string | undefined;
declare function notify(message: string): void;
declare function toast(message: string): void;
declare function confirmDialog(message: string): void;
declare function announce(message: string): void;
declare function TextField(props: Record<string, unknown>): null;
declare function Button(props: Record<string, unknown>): null;

export function Invalid() {
  return (
    <main>
      <p>No questions yet</p>
      <p>
        Multi-line
        text child
      </p>
      <p>{"Retake missed"}</p>
      <p>{`Score: ${n}`}</p>
      <p>{ok ? "Yes" : "No"}</p>
      <p>{name || "Anonymous"}</p>
      <>
        <span>Inside a fragment</span>
      </>
      <div>
        <section>
          <em>Nested element text</em>
        </section>
      </div>
      <Button aria-label="Close" />
      <Button aria-description="Closes the dialog" />
      <input aria-valuetext="Half" />
      <div aria-roledescription="Slide" />
      <img alt="Logo of the app" src="/logo.svg" />
      <abbr title="Kilobyte">kB</abbr>
      <input placeholder="Search" />
      <TextField label="Email" />
      <TextField description="We never share it" />
      <TextField helperText="At least 8 characters" />
      <TextField errorMessage="Required" />
      <Button tooltip="More" />
      <TextField emptyText="Nothing here" />
      <Button confirmText="Delete" cancelText="Keep" />
      <TextField label={"Email again"} />
      <TextField label={`Hello ${n}`} />
      <p>CSV export ready</p>
    </main>
  );
}

notify("Saved");
toast("Copied");
confirmDialog("Discard changes?");
announce(`Preview ready: ${n} questions`);
window.alert("Something happened");
window.confirm("Are you sure?");
window.prompt("Your name");
document.title = "Results";
document.title = `Results for ${n}`;
