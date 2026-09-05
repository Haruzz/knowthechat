export type StreamerProfile = { name: string; logo: string };

export default function GameChannel({
  channel,
  streamer,
}: {
  channel: string;
  streamer: StreamerProfile | null;
}) {
  return (
    <div className="game-channel">
      {streamer && <img src={streamer.logo} alt="" />}
      <div>
        <span>Playing</span>
        <strong>#{streamer?.name ?? channel}</strong>
      </div>
    </div>
  );
}
