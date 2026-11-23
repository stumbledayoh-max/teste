# Patcher Quest/OpenXR para Celular Android (Monado + Giroscópio + Hand Tracking)

Este repositório contém um **workflow automático no GitHub Actions** ("PC virtual na nuvem do GitHub") que adapta APKs OpenXR de Meta Quest para rodar em **celulares Android 64-bit (`arm64-v8a`)** com **Monado OpenXR**, **giroscópio** e **hand tracking pela câmera**, além de **reduzir a qualidade gráfica e de texturas (Unity)** para rodar mais leve no celular.

---

## O que o workflow faz automaticamente

1. **Analisa o APK** (ABIs, Unity/Unreal, `libopenxr_loader.so` Meta vs Khronos, `libOVRPlugin.so`, `libvrapi.so`, `libovrplatformloader.so`) e gera um `compatibility-report.md`.
2. **Adapta o `AndroidManifest.xml` para celular Android + Monado:**
   - Torna opcionais (`android:required="false"`) as features exclusivas de headset (`android.hardware.vr.headtracking`, `oculus.software.*`, `com.oculus.feature.*`) para que o Android permita instalar o APK normalmente.
   - Adiciona `<queries>` para o **Khronos OpenXR Runtime Broker** e os serviços do **Monado OpenXR** (`org.khronos.openxr.OpenXRRuntimeService`, `org.khronos.openxr.runtime_broker`, `org.freedesktop.monado.openxr_runtime.*`), exigido no Android 11+.
   - Adiciona a categoria `android.intent.category.LAUNCHER` na Activity principal de VR para o ícone do jogo aparecer na tela inicial do celular.
   - Ativa `android:extractNativeLibs="true"`.
3. **Troca o loader OpenXR da Meta pelo loader oficial da Khronos:**
   - Substitui `libopenxr_loader.so` pelo `org.khronos.openxr:openxr_loader_for_android` oficial (Maven Central), permitindo que o jogo encontre e se conecte ao **Monado** no celular.
4. **Reduz qualidade gráfica e texturas (Unity):**
   - Ajusta `QualitySettings` (`globalTextureMipmapLimit` / `masterTextureLimit`, MSAA `0`, sombras reduzidas/desligadas, anisotropia `0`, menos luzes por pixel) em `globalgamemanagers` (APK e/ou OBB).
   - Opcionalmente (`max_texture_size > 0`), redimensiona `Texture2D` grandes dentro dos assets Unity usando `UnityPy` + `Pillow`.
5. **Recompila, alinha (`zipalign`) e assina (`apksigner`)** o APK pronto para download nos **Artifacts** do GitHub Actions.

---

## Como usar no GitHub Actions ("PC virtual no GitHub")

1. Abra a aba **Actions** deste repositório no GitHub.
2. No menu esquerdo, clique em **Patcher Quest/OpenXR para Celular (Monado + Giroscopio + Hand Tracking)**.
3. Clique em **Run workflow** (certifique-se de selecionar a branch correta).
4. Preencha os campos:
   - **`apk_url`**: Cole o link direto do `.apk` ou um link de pasta do Gofile (`https://gofile.io/d/...`).
   - **`obb_url`** *(opcional)*: Se o `.obb` estiver em outro link direto, cole aqui.
   - **`process_obb`**: Marque se quiser que o GitHub Actions também baixe e otimize o `.obb` (para OBBs de 2 GB+, pode levar alguns minutos; desmarcado processa apenas o APK bem mais rápido).
   - **`texture_quality`**:
     - `medium` — texturas em 1/2 da resolução (25% dos pixels), MSAA desligado.
     - `low` *(recomendado)* — texturas em 1/4 da resolução (6,25% dos pixels), sombras e MSAA desligados.
     - `ultra_low` — texturas em 1/8 da resolução, tudo no mínimo.
     - `original` — sem alteração gráfica.
   - **`max_texture_size`**: Deixe `0` (usa mipmaps do Unity — mais rápido e seguro) ou escolha `512` / `256` para reescrever texturas grandes fisicamente.
   - **`swap_openxr_loader`**: Deixe marcado (`true`) para trocar o loader da Meta pelo da Khronos.
5. Ao terminar, role até a seção **Artifacts** da execução e baixe o ZIP com o APK patcheado + relatório (`compatibility-report.md`).

---

## Como rodar no celular Android (Monado + Giroscópio + Hand Tracking)

O APK patcheado fala OpenXR padrão. No celular, você precisa de um **runtime OpenXR baseado no Monado** com giroscópio e rastreamento de mãos pela câmera:

### Opção A — PhoneXR (Monado OpenXR + Hand Tracking pela câmera)
1. Baixe e instale o **PhoneXR** e o **Monado OpenXR Runtime** em: `https://github.com/samrat1games/phonexr/releases`
2. Instale o **OpenXR Runtime Broker** (Khronos) da Google Play (`org.khronos.openxr.runtime_broker`) caso não esteja usando o broker embutido do PhoneXR.
3. Abra o **PhoneXR / Monado Runtime**, conceda permissão de **câmera** (para o hand tracking) e selecione o **Monado / PhoneXR Runtime** como runtime ativo no **OpenXR Runtime Broker**.

### Opção B — HyperMagic / HyperXR (sucessor do PhoneXR)
1. Baixe em: `https://github.com/mt-VR/HyperXR/releases`
2. Possui runtime OpenXR próprio, rastreamento 3DoF por giroscópio (ou 6DoF via ARCore), hand tracking pela câmera (NPU/GPU) e suporte a controles Bluetooth/Joy-Con/segundo celular.

### Instalando o jogo patcheado + OBB no celular
1. Instale o `.apk` gerado pelo workflow no seu celular Android 64-bit.
2. Se o jogo usar arquivo `.obb`, copie o `.obb` para a pasta:
   ```text
   /Android/obb/<nome_do_pacote>/main.<versao>.<nome_do_pacote>.obb
   ```
   *(Por exemplo: `/Android/obb/com.NewFolderGames.IAmCat/main.43.com.NewFolderGames.IAmCat.obb`)*
3. Coloque o celular no óculos VR (Cardboard / VR Box) com a câmera desobstruída para o hand tracking e abra o jogo.

---

## Limitações técnicas honestas

Mesmo com o loader Khronos e o manifesto corrigido, jogos comerciais feitos exclusivamente para Meta Quest podem apresentar limitações fora de um Quest:
- **Extensões proprietárias da Meta (`XR_META_*`, `XR_FB_*`):** Se o jogo exigir uma extensão Meta obrigatória na inicialização do OpenXR que o Monado não expõe, o jogo pode fechar ao abrir.
- **Meta Platform SDK (`libovrplatformloader.so`):** Jogos que verificam licença/entitlement da Meta na inicialização podem exigir o serviço oficial da Meta.
- **Controles vs Hand Tracking:** Se o jogo só aceitar controles Touch (e não implementar `XR_EXT_hand_tracking` nativamente), use o modo de emulação de controle por gestos de mão ou controle Bluetooth/Joy-Con do PhoneXR/HyperMagic.
- **Arquitetura:** Celulares antigos com Android **32 bits** não conseguem executar APKs compilados apenas em `arm64-v8a`.
