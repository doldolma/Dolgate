declare module "react-native-vector-icons/Ionicons" {
  import type { ComponentType } from "react";
  import type { TextProps } from "react-native";

  interface IconProps extends TextProps {
    name: string;
    size?: number;
    color?: string;
  }

  const Ionicons: ComponentType<IconProps>;
  export default Ionicons;
}
