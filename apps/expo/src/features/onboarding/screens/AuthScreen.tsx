import { Ionicons } from "@expo/vector-icons";
import { useEffect, useState } from "react";
import type { ComponentProps } from "react";
import { useTranslation } from "react-i18next";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import {
  availableLoginMethods,
  coerceLoginMethod,
  FAIL_OPEN_AUTH_FLAGS,
  type LoginMethod,
  type PublicAuthFlags,
} from "../../../lib/cloud-api/public-config";
import { SheetModal } from "../../../ui/SheetModal";
import { colors, radii, shadows, spacing, typography } from "../../../ui/theme";
import { OTP_CODE_LENGTH, sanitizeOtpInput } from "../auth-otp";
import {
  canSendPhoneCode,
  DEFAULT_PHONE_PREFIX,
  normalizePhoneInput,
  type PhoneAccount,
} from "../phone-login";
import { PhoneAccountPickerSheet } from "./PhoneAccountPickerSheet";

type AuthScreenProps = {
  errorMessage: string | null;
  isBusy: boolean;
  pendingEmail: string | null;
  onBack: () => void;
  onRequestOtp: (email: string) => Promise<void>;
  onVerifyOtp: (token: string) => Promise<void>;
  onSignInWithPassword: (email: string, password: string) => Promise<void>;
  onResetPendingEmail: () => void;
  onSignInWithApple?: () => Promise<void> | void;
  onSignInWithGoogle?: () => Promise<void> | void;
  /**
   * Remote gating for the optional methods (`features.auth` from
   * `GET /v1/config/public`). Fail-open until the server answers.
   */
  authFlags?: PublicAuthFlags;
  /** Phone a code was sent to; non-null puts the screen on the code step. */
  pendingPhone?: string | null;
  /** Non-empty when the phone maps to several accounts — shows the picker. */
  phoneAccounts?: PhoneAccount[];
  onRequestPhoneOtp?: (phone: string) => Promise<void>;
  onVerifyPhoneOtp?: (code: string) => Promise<void>;
  onResetPendingPhone?: () => void;
  onSelectPhoneAccount?: (account: PhoneAccount) => Promise<void>;
  onDismissPhoneAccounts?: () => void;
  /** Opened from an invite link: say the team is joined after sign-in. */
  showInviteNotice?: boolean;
};

function isValidEmail(value: string) {
  return /\S+@\S+\.\S+/.test(value);
}

/**
 * Port of `apps/ios/AMUXApp/LoginView.swift`: a segmented method picker over
 * email-OTP, email+password and phone, then "Sign in with Apple" / "Sign in
 * with Google" rails below an "or" divider.
 *
 * Password, phone and Google are gated by `features.auth` from
 * `GET /v1/config/public`, as on iOS; email OTP and Apple never are. A phone
 * number that maps to several accounts opens an account picker.
 */
export function AuthScreen({
  errorMessage,
  isBusy,
  pendingEmail,
  onBack,
  onRequestOtp,
  onVerifyOtp,
  onSignInWithPassword,
  onResetPendingEmail,
  onSignInWithApple,
  onSignInWithGoogle,
  authFlags = FAIL_OPEN_AUTH_FLAGS,
  pendingPhone = null,
  phoneAccounts = [],
  onRequestPhoneOtp,
  onVerifyPhoneOtp,
  onResetPendingPhone,
  onSelectPhoneAccount,
  onDismissPhoneAccounts,
  showInviteNotice = false,
}: AuthScreenProps) {
  const { t } = useTranslation();
  const [email, setEmail] = useState(pendingEmail ?? "");
  const [password, setPassword] = useState("");
  const [phone, setPhone] = useState(pendingPhone ?? DEFAULT_PHONE_PREFIX);
  const [code, setCode] = useState("");
  const [method, setMethod] = useState<LoginMethod>("email");

  useEffect(() => {
    if (pendingEmail) setEmail(pendingEmail);
  }, [pendingEmail]);

  // If the selected method just got gated off, land on email rather than a
  // blank pane (iOS does the same when the flags arrive).
  useEffect(() => {
    setMethod((current) => coerceLoginMethod(current, authFlags));
  }, [authFlags]);

  const methods = availableLoginMethods(authFlags);
  const isPhoneCodeStep = pendingPhone != null;
  const isCodeStep = pendingEmail != null || isPhoneCodeStep;
  const codeDestination = pendingPhone ?? pendingEmail;

  const swallow = async (work: () => Promise<void>) => {
    try {
      await work();
    } catch {
      // The onboarding store records the message into `errorMessage` and
      // rethrows; it is already on screen. Swallowing here only stops the
      // unhandled rejection.
    }
  };

  const sendCode = async () => {
    const next = email.trim().toLowerCase();
    if (!isValidEmail(next)) return;
    await swallow(() => onRequestOtp(next));
  };

  const sendPhoneCode = async () => {
    if (!onRequestPhoneOtp || !canSendPhoneCode(phone)) return;
    const next = normalizePhoneInput(phone);
    await swallow(() => onRequestPhoneOtp(next));
  };

  const submitPassword = async () => {
    const next = email.trim().toLowerCase();
    if (!isValidEmail(next) || password.length === 0) return;
    await swallow(() => onSignInWithPassword(next, password));
  };

  const verify = async () => {
    const next = code.trim();
    if (next.length !== OTP_CODE_LENGTH) return;
    if (isPhoneCodeStep) {
      if (onVerifyPhoneOtp) await swallow(() => onVerifyPhoneOtp(next));
      return;
    }
    await swallow(() => onVerifyOtp(next));
  };

  const useDifferentDestination = () => {
    setCode("");
    if (isPhoneCodeStep) {
      onResetPendingPhone?.();
    } else {
      onResetPendingEmail();
    }
  };

  const handleApple = () => {
    if (onSignInWithApple) {
      void onSignInWithApple();
      return;
    }
    Alert.alert(t("Sign in with Apple"), t("Coming soon on Expo. Use email for now."));
  };

  const handleGoogle = () => {
    if (onSignInWithGoogle) {
      void onSignInWithGoogle();
      return;
    }
    Alert.alert(t("Sign in with Google"), t("Coming soon on Expo. Use email for now."));
  };

  const primaryAction = () => {
    if (method === "password") return submitPassword();
    if (method === "phone") return sendPhoneCode();
    return sendCode();
  };

  const canSubmit = isCodeStep
    ? code.length === OTP_CODE_LENGTH
    : method === "password"
      ? email.trim().length > 0 && password.length > 0
      : method === "phone"
        ? canSendPhoneCode(phone)
        : email.trim().length > 0;

  // Mirrors iOS `headerSubtitle`: the copy tracks the selected method, so the
  // screen never promises a code when the user picked password.
  const subtitle = isPhoneCodeStep
    ? t("Check your messages for a 6-digit code.")
    : isCodeStep
      ? t("Check your inbox for a 6-digit code.")
      : method === "phone"
        ? t("We'll text you a 6-digit code.")
        : method === "password"
          ? t("Use your email and password to sign in.")
          : t("We'll email you a 6-digit code.");

  // "Code sent to {{email}}" places the address at the end in both locales,
  // so splitting on the interpolated value keeps the address bold without
  // hardcoding word order.
  const [codeSentPrefix, codeSentSuffix] = t("Code sent to {{email}}", {
    email: "\u0000",
  }).split("\u0000");

  const methodLabel = (value: LoginMethod) =>
    value === "password" ? t("Password") : value === "phone" ? t("Phone") : t("Email");

  return (
    <KeyboardAvoidingView
      behavior={Platform.select({ ios: "padding", default: undefined })}
      style={styles.screen}
    >
      <Pressable
        accessibilityLabel={t("Back")}
        accessibilityRole="button"
        hitSlop={12}
        onPress={onBack}
        style={({ pressed }) => [styles.backButton, pressed && styles.pressed]}
      >
        <Ionicons color={colors.onyx} name="chevron-back" size={26} />
      </Pressable>

      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        {showInviteNotice ? (
          <View style={styles.inviteNotice} testID="onboarding.inviteNotice">
            <View style={styles.inviteNoticeDot} />
            <Text style={styles.inviteNoticeText}>
              {t("You've got a team invite. Sign in and you'll join the team automatically.")}
            </Text>
          </View>
        ) : null}

        <View style={styles.header}>
          <Text style={styles.title}>
            {isCodeStep ? t("Enter the code") : t("Sign in")}
          </Text>
          <Text style={styles.subtitle}>{subtitle}</Text>
        </View>

        {!isCodeStep && methods.length > 1 ? (
          <View style={styles.methodPicker} testID="login.methodPicker">
            {methods.map((value) => (
              <MethodTab
                disabled={isBusy}
                key={value}
                label={methodLabel(value)}
                onPress={() => setMethod(value)}
                selected={method === value}
              />
            ))}
          </View>
        ) : null}

        {isCodeStep ? (
          <View style={styles.section}>
            <Text style={styles.helper}>
              {codeSentPrefix}
              <Text style={styles.helperStrong}>{codeDestination}</Text>
              {codeSentSuffix}
            </Text>

            <View style={styles.authField}>
              <TextInput
                accessibilityLabel={t("6-digit code")}
                editable={!isBusy}
                keyboardType="number-pad"
                maxLength={OTP_CODE_LENGTH}
                onChangeText={(value) => setCode(sanitizeOtpInput(value))}
                placeholder={t("6-digit code")}
                placeholderTextColor={colors.slate}
                selectionColor={colors.cinnabar}
                style={styles.fieldText}
                testID="login.codeField"
                textContentType="oneTimeCode"
                value={code}
              />
            </View>

            <PrimaryButton
              busy={isBusy}
              enabled={canSubmit}
              label={t("Verify")}
              onPress={() => {
                void verify();
              }}
            />

            <Pressable
              accessibilityRole="button"
              disabled={isBusy}
              onPress={useDifferentDestination}
              style={({ pressed }) => [
                styles.linkButton,
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.linkText}>
                {isPhoneCodeStep ? t("Use a different number") : t("Use a different email")}
              </Text>
            </Pressable>
          </View>
        ) : method === "phone" ? (
          <View style={styles.section}>
            <View style={styles.authField}>
              <TextInput
                accessibilityLabel={t("Phone number")}
                autoComplete="tel"
                editable={!isBusy}
                keyboardType="phone-pad"
                onChangeText={setPhone}
                onSubmitEditing={() => {
                  void sendPhoneCode();
                }}
                placeholder={t("Phone number")}
                placeholderTextColor={colors.slate}
                selectionColor={colors.cinnabar}
                style={styles.fieldText}
                testID="login.phoneField"
                textContentType="telephoneNumber"
                value={phone}
              />
            </View>

            <PrimaryButton
              busy={isBusy}
              enabled={canSubmit}
              label={t("Send code")}
              onPress={() => {
                void sendPhoneCode();
              }}
            />
          </View>
        ) : (
          <View style={styles.section}>
            <View style={styles.authField}>
              <TextInput
                accessibilityLabel={t("Email")}
                autoCapitalize="none"
                autoComplete="email"
                autoCorrect={false}
                editable={!isBusy}
                keyboardType="email-address"
                onChangeText={setEmail}
                placeholder={t("Email")}
                placeholderTextColor={colors.slate}
                selectionColor={colors.cinnabar}
                style={styles.fieldText}
                testID="login.emailField"
                textContentType={method === "password" ? "username" : "emailAddress"}
                value={email}
              />
            </View>

            {method === "password" ? (
              <View style={styles.authField}>
                <TextInput
                  accessibilityLabel={t("Password")}
                  autoCapitalize="none"
                  autoComplete="current-password"
                  autoCorrect={false}
                  editable={!isBusy}
                  onChangeText={setPassword}
                  onSubmitEditing={() => {
                    void submitPassword();
                  }}
                  placeholder={t("Password")}
                  placeholderTextColor={colors.slate}
                  returnKeyType="go"
                  secureTextEntry
                  selectionColor={colors.cinnabar}
                  style={styles.fieldText}
                  testID="login.passwordField"
                  textContentType="password"
                  value={password}
                />
              </View>
            ) : null}

            <PrimaryButton
              busy={isBusy}
              enabled={canSubmit}
              label={method === "password" ? t("Sign in") : t("Send code")}
              onPress={() => {
                void primaryAction();
              }}
            />
          </View>
        )}

        {errorMessage ? (
          <Text style={styles.error}>{errorMessage}</Text>
        ) : null}

        <View style={styles.divider}>
          <View style={styles.dividerLine} />
          <Text style={styles.dividerText}>{t("or")}</Text>
          <View style={styles.dividerLine} />
        </View>

        <View style={styles.socialColumn}>
          <SocialButton
            disabled={isBusy}
            icon="logo-apple"
            label={t("Sign in with Apple")}
            onPress={handleApple}
          />
          {authFlags.google ? (
            <SocialButton
              disabled={isBusy}
              icon="globe-outline"
              label={t("Sign in with Google")}
              onPress={handleGoogle}
            />
          ) : null}
        </View>
      </ScrollView>

      <SheetModal
        onRequestClose={() => onDismissPhoneAccounts?.()}
        visible={phoneAccounts.length > 0}
      >
        <PhoneAccountPickerSheet
          accounts={phoneAccounts}
          onCancel={() => onDismissPhoneAccounts?.()}
          onSelect={(account) => {
            if (onSelectPhoneAccount) void swallow(() => onSelectPhoneAccount(account));
          }}
        />
      </SheetModal>
    </KeyboardAvoidingView>
  );
}

/** One segment of the method picker — RN has no built-in segmented control. */
function MethodTab({
  disabled,
  label,
  onPress,
  selected,
}: {
  disabled: boolean;
  label: string;
  onPress: () => void;
  selected: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled, selected }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.methodTab,
        selected ? styles.methodTabSelected : null,
        pressed && !disabled ? styles.pressed : null,
      ]}
    >
      <Text
        style={[
          styles.methodTabLabel,
          selected ? styles.methodTabLabelSelected : null,
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function PrimaryButton({
  busy,
  enabled,
  label,
  onPress,
}: {
  busy: boolean;
  enabled: boolean;
  label: string;
  onPress: () => void;
}) {
  const disabled = !enabled || busy;
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.primaryButton,
        enabled ? styles.primaryButtonEnabled : styles.primaryButtonDisabled,
        pressed && !disabled ? styles.pressed : null,
      ]}
    >
      <View style={styles.primaryButtonContent}>
        {busy ? (
          <ActivityIndicator
            color={enabled ? "#FFFFFF" : colors.slate}
            size="small"
          />
        ) : null}
        <Text
          style={[
            styles.primaryButtonLabel,
            enabled
              ? styles.primaryButtonLabelEnabled
              : styles.primaryButtonLabelDisabled,
          ]}
        >
          {label}
        </Text>
      </View>
    </Pressable>
  );
}

function SocialButton({
  disabled,
  icon,
  label,
  onPress,
}: {
  disabled?: boolean;
  icon: ComponentProps<typeof Ionicons>["name"];
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.socialButton,
        pressed && !disabled ? styles.pressed : null,
        disabled ? styles.disabled : null,
      ]}
    >
      <View style={styles.socialIconWrap}>
        <Ionicons color={colors.onyx} name={icon} size={19} />
      </View>
      <Text style={styles.socialLabel}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  authField: {
    backgroundColor: colors.paper,
    borderColor: colors.hairline,
    borderRadius: 16,
    borderWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  backButton: {
    left: spacing.md,
    padding: spacing.xs,
    position: "absolute",
    top: spacing.sm,
    zIndex: 10,
  },
  content: {
    gap: 24,
    paddingBottom: 36,
    paddingHorizontal: 24,
    paddingTop: 72,
  },
  disabled: {
    opacity: 0.5,
  },
  divider: {
    alignItems: "center",
    flexDirection: "row",
    gap: 14,
  },
  dividerLine: {
    backgroundColor: colors.hairline,
    flex: 1,
    height: StyleSheet.hairlineWidth,
  },
  dividerText: {
    color: colors.slate,
    fontFamily: typography.sans.fontFamily,
    fontSize: 13,
  },
  error: {
    color: colors.cinnabarDeep,
    fontFamily: typography.sans.fontFamily,
    fontSize: 13,
    lineHeight: 18,
  },
  fieldText: {
    color: colors.onyx,
    fontFamily: typography.sans.fontFamily,
    fontSize: 17,
    lineHeight: 22,
    padding: 0,
  },
  header: {
    gap: 10,
  },
  helper: {
    color: colors.basalt,
    fontFamily: typography.sans.fontFamily,
    fontSize: 13,
    lineHeight: 18,
  },
  helperStrong: {
    color: colors.basalt,
    fontWeight: "700",
  },
  inviteNotice: {
    alignItems: "flex-start",
    backgroundColor: colors.pebble,
    borderRadius: 4,
    flexDirection: "row",
    gap: 10,
    padding: 12,
  },
  inviteNoticeDot: {
    backgroundColor: colors.cinnabar,
    borderRadius: 4,
    height: 7,
    marginTop: 6,
    width: 7,
  },
  inviteNoticeText: {
    color: colors.onyx,
    flex: 1,
    fontFamily: typography.sans.fontFamily,
    fontSize: 13,
    lineHeight: 18,
  },
  linkButton: {
    alignItems: "center",
    paddingVertical: 6,
  },
  linkText: {
    color: colors.cinnabarDeep,
    fontFamily: typography.sans.fontFamily,
    fontSize: 13,
    fontWeight: "500",
  },
  pressed: {
    opacity: 0.85,
  },
  primaryButton: {
    alignItems: "center",
    borderRadius: 18,
    justifyContent: "center",
    paddingVertical: 15,
  },
  primaryButtonContent: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
    justifyContent: "center",
  },
  primaryButtonDisabled: {
    backgroundColor: "rgba(226,223,217,0.82)",
  },
  primaryButtonEnabled: {
    backgroundColor: colors.cinnabar,
    elevation: 3,
    shadowColor: colors.onyx,
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.1,
    shadowRadius: 18,
  },
  primaryButtonLabel: {
    fontFamily: typography.sans.fontFamily,
    fontSize: 17,
    fontWeight: "600",
  },
  primaryButtonLabelDisabled: {
    color: colors.slate,
  },
  primaryButtonLabelEnabled: {
    color: "#FFFFFF",
  },
  screen: {
    backgroundColor: colors.mist,
    flex: 1,
  },
  // Stands in for iOS's `.pickerStyle(.segmented)` — a recessed track with a
  // raised selected segment. React Native ships no segmented control.
  methodPicker: {
    backgroundColor: colors.pebble,
    borderRadius: radii.button + 2,
    flexDirection: "row",
    gap: 2,
    padding: 2,
  },
  methodTab: {
    alignItems: "center",
    borderRadius: radii.button,
    flex: 1,
    paddingVertical: 7,
  },
  methodTabLabel: {
    color: colors.basalt,
    ...typography.body,
    fontWeight: "500",
  },
  methodTabLabelSelected: {
    color: colors.onyx,
    fontWeight: "600",
  },
  methodTabSelected: {
    backgroundColor: colors.paper,
    ...shadows.card,
  },
  section: {
    gap: 12,
  },
  socialColumn: {
    gap: 12,
  },
  socialButton: {
    alignItems: "center",
    backgroundColor: "rgba(248,246,241,0.82)",
    borderColor: colors.hairline,
    borderRadius: 18,
    borderWidth: 1,
    flexDirection: "row",
    gap: 10,
    justifyContent: "center",
    paddingVertical: 15,
  },
  socialIconWrap: {
    alignItems: "center",
    width: 24,
  },
  socialLabel: {
    color: colors.onyx,
    fontFamily: typography.sans.fontFamily,
    fontSize: 17,
    fontWeight: "600",
  },
  subtitle: {
    color: colors.basalt,
    fontFamily: typography.sans.fontFamily,
    fontSize: 17,
    lineHeight: 23,
  },
  title: {
    color: colors.onyx,
    fontFamily: typography.serif.fontFamily,
    fontSize: 38,
    fontWeight: "400",
    letterSpacing: -0.5,
    lineHeight: 44,
  },
});
