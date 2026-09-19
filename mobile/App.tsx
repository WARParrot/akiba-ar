import { CameraView, useCameraPermissions } from 'expo-camera';
import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { Button, FlatList, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { WebView } from 'react-native-webview';
import * as api from './src/api';
import type { Capture, Hint, Spawn, User } from './src/types';
import { addMarker, updateMarker, type MarkerResult } from './src/markerState';
import { creatureAppearance, creatureLabel } from './src/creaturePresentation';


type Screen = 'login' | 'ar' | 'feed' | 'collection';

export default function App() {
  const [screen, setScreen] = useState<Screen>('login');
  const [user, setUser] = useState<User | null>(null);
  const [onsite, setOnsite] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  const [markers, setMarkers] = useState<MarkerResult[]>([]);

  useEffect(() => {
    api.init().then(() =>
      api.me().then((d) => {
        setUser(d.user);
        setOnsite(d.onsite);
        setScreen('ar');
      }).catch(() => {}),
    );
  }, []);

  // Scenario 1: Telegram login stub (real app uses Telegram Login Widget WebView or deep-link flow)
  const doLogin = async () => {
    const mockTgData = { id: 9999, first_name: 'Demo', auth_date: Math.floor(Date.now() / 1000), hash: 'mock' };
    try {
      const sess = await api.login(mockTgData);
      setUser(sess.user);
      setOnsite(sess.onsite);
      setScreen('ar');
    } catch (e) {
      alert('Login failed (backend needs TELEGRAM_BOT_TOKEN)');
    }
  };

  if (screen === 'login') {
    return (
      <View style={s.center}>
        <Text style={s.title}>Akiba AR</Text>
        <Text style={s.sub}>Connect to Hackerspace WiFi for full access</Text>
        <Button title="Login (mock)" onPress={doLogin} />
      </View>
    );
  }

  return (
    <View style={s.container}>
      <View style={s.header}>
        <Text style={s.headerText}>
          {user?.nickname} • {user?.role} • {onsite ? '🟢 onsite' : '🔴 remote'} • {user?.insight_points}pts
        </Text>
        <View style={s.tabs}>
          <Button title="AR" onPress={() => setScreen('ar')} />
          <Button title="Feed" onPress={() => setScreen('feed')} />
          <Button title="Collection" onPress={() => setScreen('collection')} />
        </View>
      </View>
      {screen === 'ar' && <ARScreen user={user!} onsite={onsite} permission={permission} requestPermission={requestPermission} markers={markers} setMarkers={setMarkers} />}
      {screen === 'feed' && <FeedScreen />}
      {screen === 'collection' && <CollectionScreen />}
    </View>
  );
}

// Scenario 3: AR camera + hint discovery + scenario 4: creature spawns
function ARScreen(p: { user: User; onsite: boolean; permission: any; requestPermission: () => void; markers: MarkerResult[]; setMarkers: Dispatch<SetStateAction<MarkerResult[]>> }) {
  const [addHintMarker, setAddHintMarker] = useState<string | null>(null);
  const requestedMarkers = useRef(new Set<string>());

  const scan = async (markerId: string) => {
    if (requestedMarkers.current.has(markerId)) return;
    requestedMarkers.current.add(markerId);
    await loadMarker(markerId);
  };

  const loadMarker = async (markerId: string) => {
    p.setMarkers((prev) => addMarker(prev, markerId));
    const [h, sp] = await Promise.all([
      api.markerHints(markerId).then((d) => d.hints).catch(() => []),
      p.onsite ? api.markerSpawns(markerId).then((d) => d.spawns).catch(() => []) : Promise.resolve([]),
    ]);
    p.setMarkers((prev) => updateMarker(prev, { markerId, hints: h, spawns: sp }));
  };

  const catchCreature = async (spawnId: number) => {
    try {
      const { species_id } = await api.catchSpawn(spawnId);
      alert(`Caught ${species_id}!`);
      p.setMarkers((prev) => prev.map((marker) => ({
        ...marker,
        spawns: marker.spawns.filter((s) => s.id !== spawnId),
      })));
    } catch (e) {
      alert(String(e));
    }
  };

  if (!p.permission?.granted) {
    return (
      <View style={s.center}>
        <Text>Camera needed for AR</Text>
        <Button title="Grant" onPress={p.requestPermission} />
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      <CameraView
        style={{ flex: 1 }}
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={({ data }) => scan(data)}
      >
        <View style={s.scanOverlay}>
          <Text style={s.scanText}>Scan a QR marker</Text>
        </View>
      </CameraView>
      {p.markers.length > 0 && (
        <View style={s.panel}>
          {p.markers.map((marker) => <View key={marker.markerId}>
            <Text style={s.panelTitle}>Marker: {marker.markerId}</Text>
            {marker.hints.map((h) => <HintCard key={h.id} hint={h} />)}
            {marker.spawns.map((sp) => <View key={sp.id} style={[s.spawn, creatureAppearance(sp).color ? { backgroundColor: creatureAppearance(sp).color } : null]}>
                <Text>{creatureAppearance(sp).emoji ?? ''} {creatureLabel(sp)} (rarity {sp.rarity})</Text>
                <Button title="Catch" onPress={() => catchCreature(sp.id)} />
              </View>)}
            {p.user.role !== 'guest' && p.onsite && <Button title="+ Add Hint" onPress={() => setAddHintMarker(marker.markerId)} />}
            {addHintMarker === marker.markerId && <AddHintForm markerId={marker.markerId} onDone={() => { setAddHintMarker(null); loadMarker(marker.markerId); }} />}
          </View>)}
        </View>
      )}
    </View>
  );
}

function HintCard({ hint }: { hint: Hint }) {
  return (
    <View style={s.hintCard}>
      <Text style={s.hintType}>{hint.type}</Text>
      <Text>{hint.text}</Text>
      {hint.html && <WebView source={{ html: hint.html }} style={{ height: 100 }} />}
      <Text style={s.score}>Score: {hint.score}</Text>
    </View>
  );
}

// Scenario 2: resident places a hint with optional HTML
function AddHintForm({ markerId, onDone }: { markerId: string; onDone: () => void }) {
  const [text, setText] = useState('');
  const [html, setHtml] = useState('');
  const [type, setType] = useState<'practical' | 'lore' | 'joke'>('practical');
  const [vis, setVis] = useState<'public' | 'residents' | 'private'>('public');

  const submit = async () => {
    try {
      await api.createHint(markerId, { text, html: html || null, type, visibility: vis, theme: 'dark' });
      onDone();
    } catch (e) {
      alert(String(e));
    }
  };

  return (
    <View style={s.form}>
      <TextInput placeholder="Text" value={text} onChangeText={setText} style={s.input} />
      <TextInput placeholder="HTML (optional)" value={html} onChangeText={setHtml} style={s.input} multiline />
      <View style={s.row}>
        {(['practical', 'lore', 'joke'] as const).map((t) => (
          <TouchableOpacity key={t} onPress={() => setType(t)}>
            <Text style={type === t ? s.selected : s.option}>{t}</Text>
          </TouchableOpacity>
        ))}
      </View>
      <View style={s.row}>
        {(['public', 'residents', 'private'] as const).map((v) => (
          <TouchableOpacity key={v} onPress={() => setVis(v)}>
            <Text style={vis === v ? s.selected : s.option}>{v}</Text>
          </TouchableOpacity>
        ))}
      </View>
      <Button title="Submit" onPress={submit} />
    </View>
  );
}

// Scenario 3: non-AR lore/joke feed for guests
function FeedScreen() {
  const [feed, setFeed] = useState<(Hint & { zone: string })[]>([]);
  useEffect(() => {
    api.feed().then((d) => setFeed(d.hints));
  }, []);
  return (
    <FlatList
      data={feed}
      keyExtractor={(item) => String(item.id)}
      renderItem={({ item }) => (
        <View style={s.feedItem}>
          <Text style={s.feedZone}>{item.zone}</Text>
          <HintCard hint={item} />
        </View>
      )}
    />
  );
}

// Scenario 4: collection screen (works offsite)
function CollectionScreen() {
  const [coll, setColl] = useState<Capture[]>([]);
  const [board, setBoard] = useState<{ nickname: string; catches: number }[]>([]);
  useEffect(() => {
    api.collection().then((d) => setColl(d.collection));
    api.leaderboard().then((d) => setBoard(d.leaderboard));
  }, []);
  return (
    <ScrollView style={s.container}>
      <Text style={s.sectionTitle}>Your Collection</Text>
      {coll.map((c) => (
        <View key={c.species_id} style={[s.captureRow, c.appearance?.color ? { backgroundColor: c.appearance.color } : null]}>
          <Text>{c.appearance?.emoji ?? ''} {creatureLabel(c)} x{c.count} (rarity {c.rarity})</Text>
        </View>
      ))}
      <Text style={s.sectionTitle}>Leaderboard</Text>
      {board.map((b, i) => (
        <Text key={i}>
          {i + 1}. {b.nickname}: {b.catches}
        </Text>
      ))}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#111' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#111', padding: 20 },
  title: { fontSize: 32, fontWeight: 'bold', color: '#0ff', marginBottom: 10 },
  sub: { fontSize: 14, color: '#aaa', marginBottom: 20, textAlign: 'center' },
  header: { backgroundColor: '#222', padding: 10 },
  headerText: { color: '#fff', fontSize: 12 },
  tabs: { flexDirection: 'row', justifyContent: 'space-around', marginTop: 10 },
  scanOverlay: { flex: 1, justifyContent: 'flex-end', alignItems: 'center', padding: 20 },
  scanText: { color: '#0ff', fontSize: 18, backgroundColor: 'rgba(0,0,0,0.7)', padding: 10 },
  panel: { backgroundColor: '#222', padding: 10, maxHeight: '50%' },
  panelTitle: { color: '#0ff', fontSize: 16, fontWeight: 'bold', marginBottom: 10 },
  hintCard: { backgroundColor: '#333', padding: 10, marginBottom: 10, borderRadius: 5 },
  hintType: { color: '#0ff', fontSize: 10, marginBottom: 5 },
  score: { color: '#aaa', fontSize: 10, marginTop: 5 },
  spawn: { backgroundColor: '#440', padding: 10, marginBottom: 10, borderRadius: 5, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  form: { backgroundColor: '#222', padding: 10, marginTop: 10, borderRadius: 5 },
  input: { backgroundColor: '#fff', padding: 8, marginBottom: 10, borderRadius: 3 },
  row: { flexDirection: 'row', justifyContent: 'space-around', marginBottom: 10 },
  option: { color: '#aaa', padding: 5 },
  selected: { color: '#0ff', fontWeight: 'bold', padding: 5 },
  feedItem: { backgroundColor: '#222', padding: 10, marginBottom: 10 },
  feedZone: { color: '#0ff', fontSize: 12, marginBottom: 5 },
  sectionTitle: { color: '#0ff', fontSize: 18, fontWeight: 'bold', marginVertical: 10 },
  captureRow: { backgroundColor: '#333', padding: 10, marginBottom: 5, borderRadius: 5 },
});
