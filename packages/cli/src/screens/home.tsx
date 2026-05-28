import { useCallback } from "react";
import { useNavigate } from "react-router";
import { Header } from "../components/header";
import { InputBar } from "../components/input-bar";

export function Home() {
  const navigate = useNavigate();

  const handleSubmit = useCallback(
    (text: string) => {
      navigate("/sessions/new", { state: { message: text } });
    },
    [navigate],
  );

  return (
    <box
      alignItems="center"
      justifyContent="center"
      flexGrow={1}
      width="100%"
      height="100%"
      gap={2}
      position="relative"
    >
      <Header />
      <box width="100%" maxWidth={70} paddingX={2}>
        <InputBar disabled={false} onSubmit={handleSubmit} />
      </box>
    </box>
  );
}
