import { HugeiconsIcon, type HugeiconsIconProps, type IconSvgElement } from "@hugeicons/react";
import {
  PlusSignIcon,
  ArrowUpRight01Icon,
  Loading03Icon,
  SquareIcon,
  RoboticIcon,
  Edit02Icon,
  ArrowRight02Icon,
  Activity01Icon,
  LeftToRightListBulletIcon,
  PlayIcon,
  Upload01Icon,
  SmartPhone01Icon,
  Alert02Icon,
  CheckmarkCircle02Icon,
  Link01Icon,
  Calendar03Icon,
  CalendarCheckIn01Icon,
  CodeIcon,
  ArrowDown01Icon,
  ArrowLeftDoubleIcon,
  ArrowRightDoubleIcon,
  ArrowRight01Icon,
  Download01Icon,
  File01Icon,
  Analytics01Icon,
  HelpCircleIcon,
  MailOpen01Icon,
  DashboardCircleIcon,
  SquareLock02Icon,
  Menu01Icon,
  Moon02Icon,
  Calling02Icon,
  Search01Icon,
  SentIcon,
  Settings01Icon,
  SparklesIcon,
  Sun03Icon,
  UserCircleIcon,
  UserMultiple02Icon,
  ArrowLeft02Icon,
  Tick02Icon,
  Clock01Icon,
  Copy01Icon,
  FileAudioIcon,
  FileImageIcon,
  GripIcon,
  FileVideoIcon,
  FilterHorizontalIcon,
  Mail01Icon,
  BubbleChatIcon,
  MoreHorizontalIcon,
  MoreVerticalIcon,
  Attachment01Icon,
  Call02Icon,
  ArrowReloadHorizontalIcon,
  SmileIcon,
  StarIcon,
  Delete02Icon,
  Cancel01Icon,
} from "@hugeicons/core-free-icons";

type InterfaceIconProps = Omit<HugeiconsIconProps, "icon">;

function roundedIcon(icon: IconSvgElement) {
  return function RoundedIcon({ size = 20, strokeWidth = 1.5, ...props }: InterfaceIconProps) {
    return <HugeiconsIcon icon={icon} size={size} strokeWidth={strokeWidth} aria-hidden={props["aria-label"] || props["aria-labelledby"] ? undefined : true} {...props} />;
  };
}

export const Cable = roundedIcon(Link01Icon);
export const CalendarDays = roundedIcon(Calendar03Icon);
export const CalendarCheck = roundedIcon(CalendarCheckIn01Icon);
export const Code2 = roundedIcon(CodeIcon);
export const Grip = roundedIcon(GripIcon);
export const ChevronDown = roundedIcon(ArrowDown01Icon);
export const ChevronsLeft = roundedIcon(ArrowLeftDoubleIcon);
export const ChevronsRight = roundedIcon(ArrowRightDoubleIcon);
export const ChevronRight = roundedIcon(ArrowRight01Icon);
export const Download = roundedIcon(Download01Icon);
export const FileText = roundedIcon(File01Icon);
export const Grid2x2 = roundedIcon(Analytics01Icon);
export const HelpCircle = roundedIcon(HelpCircleIcon);
export const Inbox = roundedIcon(MailOpen01Icon);
export const LayoutGrid = roundedIcon(DashboardCircleIcon);
export const LockKeyhole = roundedIcon(SquareLock02Icon);
export const Menu = roundedIcon(Menu01Icon);
export const Moon = roundedIcon(Moon02Icon);
export const PhoneCall = roundedIcon(Calling02Icon);
export const Search = roundedIcon(Search01Icon);
export const Send = roundedIcon(SentIcon);
export const Settings = roundedIcon(Settings01Icon);
export const Sparkles = roundedIcon(SparklesIcon);
export const Sun = roundedIcon(Sun03Icon);
export const UserRound = roundedIcon(UserCircleIcon);
export const Users = roundedIcon(UserMultiple02Icon);
export const ArrowLeft = roundedIcon(ArrowLeft02Icon);
export const Check = roundedIcon(Tick02Icon);
export const Clock = roundedIcon(Clock01Icon);
export const Copy = roundedIcon(Copy01Icon);
export const FileAudio = roundedIcon(FileAudioIcon);
export const FileImage = roundedIcon(FileImageIcon);
export const FileVideo = roundedIcon(FileVideoIcon);
export const Filter = roundedIcon(FilterHorizontalIcon);
export const Mail = roundedIcon(Mail01Icon);
export const MessageCircle = roundedIcon(BubbleChatIcon);
export const MoreHorizontal = roundedIcon(MoreHorizontalIcon);
export const MoreVertical = roundedIcon(MoreVerticalIcon);
export const Paperclip = roundedIcon(Attachment01Icon);
export const Phone = roundedIcon(Call02Icon);
export const RotateCcw = roundedIcon(ArrowReloadHorizontalIcon);
export const Smile = roundedIcon(SmileIcon);
export const Star = roundedIcon(StarIcon);
export const Trash2 = roundedIcon(Delete02Icon);
export const X = roundedIcon(Cancel01Icon);

export const Plus = roundedIcon(PlusSignIcon);
export const ArrowUpRight = roundedIcon(ArrowUpRight01Icon);
export const LoaderCircle = roundedIcon(Loading03Icon);
export const Square = roundedIcon(SquareIcon);
export const Bot = roundedIcon(RoboticIcon);
export const Pencil = roundedIcon(Edit02Icon);
export const ArrowRight = roundedIcon(ArrowRight02Icon);
export const Activity = roundedIcon(Activity01Icon);
export const List = roundedIcon(LeftToRightListBulletIcon);
export const Play = roundedIcon(PlayIcon);
export const Upload = roundedIcon(Upload01Icon);
export const Smartphone = roundedIcon(SmartPhone01Icon);
export const AlertTriangle = roundedIcon(Alert02Icon);
export const CheckCircle2 = roundedIcon(CheckmarkCircle02Icon);
