/**
 * Expo / React Native entry for the Sutra edge companion.
 * Install Expo peers (`expo`, `react`, `react-native`) before launching
 * on a device; Node smoke uses `scripts/smoke.ts` instead.
 */
import { useCallback, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { runEdgeTurn } from "./src/companion.ts";

const DEFAULT_SUBJECT = "edge-subject";
const DEFAULT_DEVICE = "edge-device";

export default function App() {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("Ready — tap to run one on-device turn");
  const [replyLen, setReplyLen] = useState(0);

  const onPress = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const out = await runEdgeTurn({
        subjectId: DEFAULT_SUBJECT,
        deviceId: DEFAULT_DEVICE,
        sessionId: "edge-session",
        utterance: "Hello from Expo edge seam.",
        storageBackend: "memory",
      });
      setReplyLen(out.reply?.length ?? 0);
      setStatus(`ok subject=${out.subjectId} device=${out.deviceId}`);
    } catch (err) {
      setStatus(`fail: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }, [busy]);

  return (
    <View style={styles.root}>
      <Text style={styles.title}>Sutra Edge Companion</Text>
      <Text style={styles.meta}>locality: on-device · storage: StorageDriver seam</Text>
      <Pressable style={styles.button} onPress={onPress} disabled={busy}>
        {busy ? <ActivityIndicator /> : <Text style={styles.buttonText}>Run mock turn</Text>}
      </Pressable>
      <Text style={styles.status}>{status}</Text>
      {replyLen > 0 ? <Text style={styles.meta}>reply length={replyLen}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    justifyContent: "center",
    padding: 24,
    gap: 12,
  },
  title: {
    fontSize: 22,
    fontWeight: "600",
  },
  meta: {
    fontSize: 13,
    opacity: 0.7,
  },
  button: {
    marginTop: 8,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 8,
    backgroundColor: "#1a1a1a",
    alignItems: "center",
  },
  buttonText: {
    color: "#ffffff",
    fontSize: 16,
  },
  status: {
    marginTop: 8,
    fontSize: 14,
  },
});
