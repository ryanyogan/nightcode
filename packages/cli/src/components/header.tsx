export function Header() {
  return (
    <box justifyContent="center" alignItems="center">
      <box
        flexDirection="row"
        justifyContent="center"
        gap={0.5}
        alignItems="center"
      >
        <ascii-font font="tiny" text="bIG" color="orange" />
        <ascii-font font="tiny" text="Pickle" />
      </box>
    </box>
  );
}
