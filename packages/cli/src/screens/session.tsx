import { useParams } from "react-router";
import { useTheme } from "../providers/theme";

export function Session() {
  const { id } = useParams();
  const { colors } = useTheme();

  return (
    <box flexGrow={1} padding={2}>
      <text fg={colors.primary}>Session {id}</text>
    </box>
  );
}
