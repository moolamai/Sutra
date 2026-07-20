/**
 * Ambient shim so App.tsx typechecks on a Node-only machine without
 * installing react-native (peerDependency remains optional).
 */
declare module "react-native" {
  import type { ComponentType, ReactNode } from "react";

  type Style = Record<string, unknown> | unknown;

  export const View: ComponentType<{ style?: Style; children?: ReactNode }>;
  export const Text: ComponentType<{ style?: Style; children?: ReactNode }>;
  export const Pressable: ComponentType<{
    style?: Style;
    children?: ReactNode;
    onPress?: () => void;
    disabled?: boolean;
  }>;
  export const ActivityIndicator: ComponentType<{ style?: Style }>;
  export const StyleSheet: {
    create<T extends Record<string, Record<string, unknown>>>(styles: T): T;
  };
}
