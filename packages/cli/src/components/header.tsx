export function Header() {
  return (
    <box justifyContent="center" alignItems="center">
      <box
        flexDirection="row"
        justifyContent="center"
        gap={1}
        alignItems="center"
      >
        <ascii-font font="tiny" text="Chroma" color="orange" />
        <ascii-font font="tiny" text="code" />
      </box>
    </box>
  );
}
