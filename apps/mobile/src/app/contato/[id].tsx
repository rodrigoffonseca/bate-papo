import { CameraView, useCameraPermissions } from 'expo-camera';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, Modal, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { errorMessage } from '@/components/format';
import { QrCode } from '@/components/qr-code';
import { Avatar, Button, Txt } from '@/components/ui';
import { contactTitle } from '@/core/history';
import { type VerificationState, safetyNumberBlocks, safetyQrPayload } from '@/core/safety';
import { useAppState, useHistoryQuery, useService } from '@/platform/app';
import { spacing, useTheme } from '@/theme';

/** Número de segurança e estado de verificação de um contato. */
function useSafety(peerId: string) {
  const service = useService();
  const { verificationVersion, identityAlert } = useAppState();
  const [info, setInfo] = useState<{ number: string | null; state: VerificationState }>();
  useEffect(() => {
    let alive = true;
    void Promise.all([service.safetyNumber(peerId), service.verificationState(peerId)]).then(
      ([number, state]) => alive && setInfo({ number: number ?? null, state }),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [service, peerId, verificationVersion, identityAlert?.at]);
  return info;
}

const STATE_TEXT: Record<VerificationState, string> = {
  verified: '✅ Verificado',
  unverified: 'Não verificado',
  changed: '⚠️ A chave mudou depois da verificação',
};

/**
 * Dados de um contato: número de segurança (com QR code para conferir), e,
 * quando aberto a partir de um grupo, as ações de administrador.
 */
export default function Contato() {
  const { id, grupo } = useLocalSearchParams<{ id: string; grupo?: string }>();
  const service = useService();
  const router = useRouter();
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { me } = useAppState();
  const contact = useHistoryQuery((h) => h.getContact(id), [id]);
  const group = useHistoryQuery((h) => (grupo ? h.getGroup(grupo) : Promise.resolve(null)), [grupo]);
  const safety = useSafety(id);
  const [permission, requestPermission] = useCameraPermissions();
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);

  const name = contactTitle(contact);
  const member = group?.members.find((m) => m.userId === id);
  const iAmAdmin = !!group?.active && group.members.some((m) => m.userId === me?.id && m.role === 'admin');

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      Alert.alert('Não foi possível concluir', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const startScan = async () => {
    const p = permission?.granted ? permission : await requestPermission();
    if (!p.granted) {
      Alert.alert('Câmera bloqueada', 'Permita o uso da câmera nos ajustes do celular para ler o código.');
      return;
    }
    setScanning(true);
  };

  const onScanned = async (data: string) => {
    if (!scanning) return;
    setScanning(false);
    const result = await service.verifyScannedCode(id, data);
    if (result === 'match') {
      Alert.alert('Verificado ✅', `O número de segurança confere. A conversa com ${name} é só entre vocês.`);
    } else if (result === 'mismatch') {
      Alert.alert(
        'Os números não conferem',
        `Peça para ${name} abrir esta mesma tela no celular. Se continuar diferente, alguém pode estar interceptando a conversa: não troque informações sensíveis.`,
      );
    } else {
      Alert.alert('Código inválido', 'Esse não é um código de número de segurança do Bate-Papo.');
    }
  };

  const openChat = () =>
    void service.openDirectConversation(id).then((cid) => router.dismissTo({ pathname: '/chat/[id]', params: { id: cid } }));

  return (
    <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg, paddingBottom: insets.bottom + spacing.lg }}>
      <Stack.Screen options={{ title: name }} />
      <View style={{ alignItems: 'center', gap: spacing.xs }}>
        <Avatar name={name} seed={id} size={80} />
        <Txt style={{ fontSize: 20, fontWeight: '700' }}>{name}</Txt>
        {contact?.username && contact.displayName ? <Txt muted>@{contact.username}</Txt> : null}
      </View>
      {id !== me?.id && <Button variant="ghost" title="Conversar" onPress={openChat} />}

      <View style={{ gap: spacing.md, alignItems: 'center' }}>
        <Txt style={{ fontWeight: '700', alignSelf: 'flex-start' }}>Número de segurança</Txt>
        {safety === undefined ? null : !safety.number ? (
          <Txt muted>Troque ao menos uma mensagem com {name} para ver o número de segurança.</Txt>
        ) : (
          <>
            <Txt
              accessibilityLiveRegion="polite"
              style={{
                alignSelf: 'flex-start',
                fontWeight: '600',
                color: safety.state === 'verified' ? t.primary : safety.state === 'changed' ? t.danger : t.textMuted,
              }}
            >
              {STATE_TEXT[safety.state]}
            </Txt>
            <View accessible accessibilityLabel={`Código QR do número de segurança com ${name}`}>
              <QrCode value={safetyQrPayload(safety.number)} />
            </View>
            <View
              accessible
              accessibilityLabel={`Número de segurança: ${safetyNumberBlocks(safety.number).join(', ')}`}
              style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: spacing.sm, maxWidth: 300 }}
            >
              {safetyNumberBlocks(safety.number).map((b, i) => (
                <Txt key={i} style={{ fontFamily: 'monospace', fontSize: 18, width: 64, textAlign: 'center' }}>
                  {b}
                </Txt>
              ))}
            </View>
            <Txt muted style={{ fontSize: 14 }}>
              Para ter certeza de que ninguém está no meio da conversa, encontre {name} pessoalmente e leia com o seu
              celular o código que aparece no celular de {name}, ou compare os números por telefone. Se forem iguais, a conversa é só entre vocês.
            </Txt>
            <Button title="Ler o código da outra pessoa" onPress={() => void startScan()} disabled={busy} />
            {safety.state === 'verified' ? (
              <Button
                variant="ghost"
                title="Remover verificação"
                onPress={() => void run(() => service.setVerified(id, false))}
                disabled={busy}
              />
            ) : (
              <Button
                variant="ghost"
                title="Conferi os números: marcar como verificado"
                onPress={() => void run(() => service.setVerified(id, true))}
                disabled={busy}
              />
            )}
          </>
        )}
      </View>

      {group && member && iAmAdmin && (
        <View style={{ gap: spacing.sm }}>
          <Txt style={{ fontWeight: '700' }}>No grupo {group.name}</Txt>
          <Button
            variant="ghost"
            title={member.role === 'admin' ? 'Remover de administrador' : 'Tornar administrador'}
            onPress={() => void run(() => service.setGroupAdmin(group.id, id, member.role !== 'admin'))}
            disabled={busy}
          />
          <Button
            variant="danger"
            title="Remover do grupo"
            onPress={() =>
              Alert.alert(`Remover ${name}?`, undefined, [
                { text: 'Cancelar', style: 'cancel' },
                {
                  text: 'Remover',
                  style: 'destructive',
                  onPress: () => void run(() => service.removeGroupMember(group.id, id)).then(() => router.back()),
                },
              ])
            }
            disabled={busy}
          />
        </View>
      )}

      <Modal visible={scanning} animationType="slide" onRequestClose={() => setScanning(false)}>
        <View style={{ flex: 1, backgroundColor: '#000' }}>
          <CameraView
            style={{ flex: 1 }}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={(r) => void onScanned(r.data)}
          />
          <View style={{ padding: spacing.lg, paddingBottom: insets.bottom + spacing.lg, gap: spacing.md }}>
            <Txt style={{ color: '#fff', textAlign: 'center' }}>
              Aponte para o código QR na tela de número de segurança do celular de {name}.
            </Txt>
            <Button variant="ghost" title="Cancelar" onPress={() => setScanning(false)} />
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}
