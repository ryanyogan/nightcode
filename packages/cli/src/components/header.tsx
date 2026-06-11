export function Header() {
  return (
    <box justifyContent="center" alignItems="center">
      <box
        flexDirection="row"
        justifyContent="center"
        gap={0.5}
        alignItems="center"
      >
        <ascii-font font="block" text="EX" color="orange" />
        <ascii-font font="block" text="Code" />
      </box>
    </box>
  );
}
