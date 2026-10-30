// rbx/codeeditor.js — NeoStudio's script editor, laid out like a game studio's: scripts open as
// tabs over the 3D view ("Place" tab goes back to it), with JavaScript syntax highlighting,
// line numbers, auto-indent, autocomplete for the Roblox-style API, live "Script Analysis"
// (syntax errors as you type), an Examples menu and an API cheat sheet.
// The code is saved into the build as you type; F5 plays, Ctrl/⌘+S just confirms the save.
'use strict';
(function(){
  const CE = window.NeoCodeEditor = {};
  const $ = (q, r)=> (r||document).querySelector(q);
  const esc = (t)=> String(t==null?'':t).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const LINE_H = 19;

  // ------------------------------------------------------------------ starter code
  CE.templates = {
    part:
`// A Script inside a part: it starts when the game starts, and script.Parent is the part.
const part = script.Parent;

part.Touched.Connect((hit) => {
  const player = game.Players.GetPlayerFromCharacter(hit.Parent);
  if (player) {
    print(player.Name + " touched " + part.Name);
  }
});
`,
    world:
`// Scripts in ServerScriptService start when the game starts.
const Players = game.GetService("Players");

Players.PlayerAdded.Connect((player) => {
  print("Welcome, " + player.Name + "!");
});
`,
    gui:
`// A Script inside a TextButton: script.Parent is the button.
const button = script.Parent;

button.MouseButton1Click.Connect(() => {
  print("Button clicked!");
});
`,
  };

  const EXAMPLES = [
    { name:'Kill brick', where:'part', code:
`// Touching this part knocks the player out
const part = script.Parent;

part.Touched.Connect((hit) => {
  const humanoid = hit.Parent.FindFirstChild("Humanoid");
  if (humanoid) {
    humanoid.Health = 0;
  }
});
` },
    { name:'Disappearing part', where:'part', code:
`// Fades away a moment after you step on it, then comes back
const part = script.Parent;
let busy = false;

part.Touched.Connect(async (hit) => {
  if (busy || !game.Players.GetPlayerFromCharacter(hit.Parent)) return;
  busy = true;
  for (let i = 1; i <= 10; i++) {
    part.Transparency = i / 10;
    await wait(0.05);
  }
  part.CanCollide = false;
  await wait(3);
  part.CanCollide = true;
  part.Transparency = 0;
  busy = false;
});
` },
    { name:'Coin + leaderboard', where:'part', code:
`// A spinning coin: touch it to collect it (shows "Coins" on the leaderboard)
const coin = script.Parent;
coin.Shape = Enum.PartType.Cylinder;
coin.Size = new Vector3(0.9, 0.2, 0.9);
coin.Color = Color3.fromRGB(255, 205, 40);
coin.Material = Enum.Material.Neon;
coin.CanCollide = false;

game.GetService("RunService").Heartbeat.Connect((dt) => {
  coin.Orientation = new Vector3(90, coin.Orientation.Y + 120 * dt, 0);
});

coin.Touched.Connect((hit) => {
  const player = game.Players.GetPlayerFromCharacter(hit.Parent);
  if (!player || coin.Transparency > 0) return;
  let stats = player.FindFirstChild("leaderstats");
  if (!stats) {
    stats = Instance.new("Folder");
    stats.Name = "leaderstats";
    stats.Parent = player;
  }
  let coins = stats.FindFirstChild("Coins");
  if (!coins) {
    coins = Instance.new("IntValue");
    coins.Name = "Coins";
    coins.Parent = stats;
  }
  coins.Value += 1;
  game.SoundService.PlayLocalSound("checkpoint");
  coin.Transparency = 1;
  task.delay(5, () => { coin.Transparency = 0; }); // comes back after 5 seconds
});
` },
    { name:'Moving platform', where:'part', code:
`// Slides back and forth forever — players standing on it ride along
const TweenService = game.GetService("TweenService");
const platform = script.Parent;
platform.Size = new Vector3(3, 0.5, 3);

const start = platform.Position;
const info = new TweenInfo(3, Enum.EasingStyle.Sine, Enum.EasingDirection.InOut, -1, true);
const tween = TweenService.Create(platform, info, { Position: start.add(new Vector3(0, 0, -8)) });
tween.Play();
` },
    { name:'Spinning part', where:'part', code:
`// Spins around all the time
const part = script.Parent;
const RunService = game.GetService("RunService");

RunService.Heartbeat.Connect((dt) => {
  part.Orientation = part.Orientation.add(new Vector3(0, 90 * dt, 0));
});
` },
    { name:'Speed pad', where:'part', code:
`// Step on it to run twice as fast for 5 seconds
const pad = script.Parent;

pad.Touched.Connect(async (hit) => {
  const humanoid = hit.Parent.FindFirstChild("Humanoid");
  if (!humanoid || humanoid.WalkSpeed > 16) return;
  humanoid.WalkSpeed = 32;
  await wait(5);
  humanoid.WalkSpeed = 16;
});
` },
    { name:'Click to change color', where:'part', code:
`// Click the part to give it a random color
const part = script.Parent;
const detector = Instance.new("ClickDetector");
detector.Parent = part;

detector.MouseClick.Connect((player) => {
  part.Color = Color3.fromHSV(Math.random(), 0.8, 1);
  print(player.Name + " clicked the part");
});
` },
    { name:'Lamp (light at night)', where:'part', code:
`// A glowing lamp
const part = script.Parent;
part.Material = Enum.Material.Neon;
part.Color = Color3.fromRGB(255, 220, 140);

const light = Instance.new("PointLight");
light.Range = 14;
light.Brightness = 2;
light.Color = part.Color;
light.Parent = part;
` },
    { name:'Flip through pictures', where:'part', code:
`// Swaps this part's decal between two pictures every second.
// Give the part a Decal first (🖼 Decal), then paste a second picture's id below.
const part = script.Parent;
const decal = part.FindFirstChildOfClass("Decal");
const pictures = [decal ? decal.Texture : "", "PASTE-ANOTHER-PICTURE-ID"];
let i = 0;

while (decal) {
  await wait(1);
  i = (i + 1) % pictures.length;
  decal.Texture = pictures[i];
}
` },
    { name:'Leaderboard (Points)', where:'world', code:
`// Gives every player a "Points" stat on the leaderboard, +1 every second
const Players = game.GetService("Players");

Players.PlayerAdded.Connect(async (player) => {
  const leaderstats = Instance.new("Folder");
  leaderstats.Name = "leaderstats";
  leaderstats.Parent = player;

  const points = Instance.new("IntValue");
  points.Name = "Points";
  points.Parent = leaderstats;

  while (player.Parent) {
    await wait(1);
    points.Value += 1;
  }
});
` },
    { name:'Save coins (DataStore)', where:'world', code:
`// Saves each player's Coins, so they're still there the next time they play.
// Add the "Coin + leaderboard" example to some parts so there are coins to collect!
const Players = game.GetService("Players");
const DataStoreService = game.GetService("DataStoreService");
const store = DataStoreService.GetDataStore("PlayerData");

Players.PlayerAdded.Connect(async (player) => {
  const leaderstats = Instance.new("Folder");
  leaderstats.Name = "leaderstats";
  leaderstats.Parent = player;

  const coins = Instance.new("IntValue");
  coins.Name = "Coins";
  coins.Parent = leaderstats;

  // load what was saved last time (nothing yet the first time someone plays)
  const key = "Player_" + player.UserId;
  const saved = await store.GetAsync(key);
  if (saved) coins.Value = saved.Coins || 0;

  // save whenever the coins change (Neoblox writes it a moment later, and when you leave)
  coins.Changed.Connect(() => {
    store.SetAsync(key, { Coins: coins.Value });
  });
});
` },
    { name:'Visit counter (DataStore)', where:'world', code:
`// Remembers how many times each player has played this game
const store = game.GetService("DataStoreService").GetDataStore("Visits");

game.Players.PlayerAdded.Connect(async (player) => {
  const visits = await store.IncrementAsync("Player_" + player.UserId, 1);
  game.StarterGui.SetCore("SendNotification", {
    Title: visits === 1 ? "Welcome!" : "Welcome back!",
    Text: "This is your visit number " + visits,
  });
});
` },
    { name:'VIP game pass', where:'world', code:
`// Players who own your game pass run faster. Make the pass in 🛒 Paid Items first.
const MarketplaceService = game.GetService("MarketplaceService");
const PASS_ID = 0; // ← paste your game pass id here

function givePerk(player) {
  const speedUp = (character) => { character.Humanoid.WalkSpeed = 24; };
  player.CharacterAdded.Connect(speedUp);
  if (player.Character) speedUp(player.Character);
  game.StarterGui.SetCore("SendNotification", { Title: "⭐ VIP", Text: "Thanks for supporting this game!" });
}

game.Players.PlayerAdded.Connect(async (player) => {
  if (await MarketplaceService.UserOwnsGamePassAsync(player.UserId, PASS_ID)) givePerk(player);
});

// bought it in the middle of the game? give it right away
MarketplaceService.PromptGamePassPurchaseFinished.Connect((player, passId, purchased) => {
  if (purchased && passId === PASS_ID) givePerk(player);
});
` },
    { name:'Sell coins (developer product)', where:'world', code:
`// Sells 100 Coins for tokens, as many times as players like. Make a developer product in
// 🛒 Paid Items first. (Add "Save coins (DataStore)" too, so bought coins are kept.)
const MarketplaceService = game.GetService("MarketplaceService");
const PRODUCT_ID = 0; // ← paste your developer product id here

// Runs for every purchase. Return PurchaseGranted once the player has what they paid for;
// anything else and they get it the next time they play.
MarketplaceService.ProcessReceipt = (receipt) => {
  if (receipt.ProductId !== PRODUCT_ID) return Enum.ProductPurchaseDecision.NotProcessedYet;
  const player = game.Players.GetPlayerByUserId(receipt.PlayerId);
  const stats = player && player.FindFirstChild("leaderstats");
  const coins = stats && stats.FindFirstChild("Coins");
  if (!coins) return Enum.ProductPurchaseDecision.NotProcessedYet;
  coins.Value += 100;
  return Enum.ProductPurchaseDecision.PurchaseGranted;
};

// press B to open the buy window (or use a button: "Button: buy something")
game.GetService("UserInputService").InputBegan.Connect((input, typing) => {
  if (!typing && input.KeyCode === Enum.KeyCode.B) {
    MarketplaceService.PromptProductPurchase(game.Players.LocalPlayer, PRODUCT_ID);
  }
});
` },
    { name:'Play an animation', where:'world', code:
`// Press 1, 2 or 3 to wave, dance or sit. Everyone in the game sees it.
// Ready-made animations: wave, point, cheer, clap, dance, dance2, dance3, sit, bow, salute,
// nod, shake, shrug, laugh, kick, punch, spin, flip, jumpingjacks, zombie
const UserInputService = game.GetService("UserInputService");
const tracks = {};

function load(name) {
  const humanoid = game.Players.LocalPlayer.Character.Humanoid;
  const anim = Instance.new("Animation");
  anim.AnimationId = name;
  return humanoid.Animator.LoadAnimation(anim);
}

game.Players.LocalPlayer.CharacterAdded.Connect(() => {
  tracks.wave = load("wave");
  tracks.dance = load("dance");   // dance loops until you stop it
  tracks.sit = load("sit");
});

UserInputService.InputBegan.Connect((input, typing) => {
  if (typing || !tracks.wave) return;
  if (input.KeyCode === Enum.KeyCode.One) tracks.wave.Play();
  if (input.KeyCode === Enum.KeyCode.Two) { if (tracks.dance.IsPlaying) tracks.dance.Stop(); else tracks.dance.Play(); }
  if (input.KeyCode === Enum.KeyCode.Three) { if (tracks.sit.IsPlaying) tracks.sit.Stop(); else tracks.sit.Play(); }
});
` },
    { name:'Make your own animation', where:'world', code:
`// Your own animation, made of keyframes. Angles are in degrees:
//   arms and legs: X swings forward (90 = straight ahead, 180 = straight up), Z swings out to the side
//   Head, Torso (bends at the hips) and Body (the whole character): X forward, Y turns left, Z tilts right
//   Lift: move the whole character up (or down) in studs
const anim = Instance.new("Animation");
anim.Keyframes = [
  { Time: 0 },
  { Time: 0.3, RightArm: new Vector3(170, 0, 20), LeftArm: new Vector3(170, 0, 20), Lift: 0.5, EasingStyle: Enum.EasingStyle.Sine },
  { Time: 0.6, RightArm: new Vector3(0, 0, 80), LeftArm: new Vector3(0, 0, 80), Body: new Vector3(0, 180, 0), Lift: 0, Name: "Land" },
  { Time: 1.0, RightArm: new Vector3(0, 0, 0), LeftArm: new Vector3(0, 0, 0), Body: new Vector3(0, 360, 0) },
];

game.Players.LocalPlayer.CharacterAdded.Connect(async (character) => {
  const track = character.Humanoid.Animator.LoadAnimation(anim);
  // keyframes with a Name fire an event when the animation reaches them
  track.GetMarkerReachedSignal("Land").Connect(() => game.SoundService.PlayLocalSound("land"));
  while (character.Parent) {
    track.Play();
    await track.Ended.Wait();
    await wait(2);
  }
});
` },
    { name:'Day / night cycle', where:'world', code:
`// Time of day keeps moving: day, sunset, night, sunrise…
const Lighting = game.GetService("Lighting");

while (true) {
  Lighting.ClockTime = (Lighting.ClockTime + 0.25) % 24;
  await wait(1);
}
` },
    { name:'Rain parts from the sky', where:'world', code:
`// Drops a colored ball from the sky every second
while (true) {
  const ball = Instance.new("Part");
  ball.Shape = Enum.PartType.Ball;
  ball.Color = Color3.fromHSV(Math.random(), 0.7, 1);
  ball.Position = new Vector3(math.random(-10, 10), 25, math.random(-10, 10));
  ball.Anchored = false;
  ball.Parent = workspace;
  game.GetService("Debris").AddItem(ball, 8); // cleaned up after 8 seconds
  await wait(1);
}
` },
    { name:'Welcome message', where:'world', code:
`// Says hi when you join
game.Players.PlayerAdded.Connect((player) => {
  game.StarterGui.SetCore("SendNotification", {
    Title: "Welcome!",
    Text: "Hi " + player.Name + ", have fun!",
  });
});
` },
    { name:'Press E to jump high', where:'world', code:
`// Press E for a super jump
const UserInputService = game.GetService("UserInputService");

UserInputService.InputBegan.Connect((input, typing) => {
  if (typing) return;
  if (input.KeyCode === Enum.KeyCode.E) {
    const root = game.Players.LocalPlayer.Character.HumanoidRootPart;
    root.AssemblyLinearVelocity = new Vector3(0, 20, 0);
  }
});
` },
    { name:'Button: teleport to spawn', where:'gui', code:
`// Clicking this button teleports you back to the start
const button = script.Parent;

button.MouseButton1Click.Connect(() => {
  const character = game.Players.LocalPlayer.Character;
  character.MoveTo(new Vector3(0.5, 2, 0.5));
});
` },
    { name:'Button: countdown', where:'gui', code:
`// Counts down on the button when you click it
const button = script.Parent;
let counting = false;

button.MouseButton1Click.Connect(async () => {
  if (counting) return;
  counting = true;
  for (let i = 10; i > 0; i--) {
    button.Text = String(i);
    await wait(1);
  }
  button.Text = "Go!";
  counting = false;
});
` },
    { name:'Button: buy something', where:'gui', code:
`// Clicking this button opens the buy window for your game pass.
// For a developer product, use PromptProductPurchase instead.
const MarketplaceService = game.GetService("MarketplaceService");
const PASS_ID = 0; // ← paste your game pass id here
const button = script.Parent;

button.MouseButton1Click.Connect(() => {
  MarketplaceService.PromptGamePassPurchase(game.Players.LocalPlayer, PASS_ID);
});
` },
    { name:'Button: emote', where:'gui', code:
`// Clicking this button does a little dance (click again to stop)
const button = script.Parent;
let track = null;

button.MouseButton1Click.Connect(() => {
  if (!track) {
    const anim = Instance.new("Animation");
    anim.AnimationId = "dance2";
    track = game.Players.LocalPlayer.Character.Humanoid.Animator.LoadAnimation(anim);
  }
  if (track.IsPlaying) { track.Stop(); button.Text = "Dance"; }
  else { track.Play(); button.Text = "Stop"; }
});
` },
  ];

  const HELP = `
<h3>Scripting in Neoblox</h3>
<p>Scripts are <b>JavaScript</b>, using the same objects and names as Roblox. They start when the game starts.</p>
<table>
<tr><th>Roblox Lua</th><th>Neoblox JavaScript</th></tr>
<tr><td>local part = script.Parent</td><td>const part = script.Parent;</td></tr>
<tr><td>part.Touched:Connect(function(hit) … end)</td><td>part.Touched.Connect((hit) =&gt; { … });</td></tr>
<tr><td>wait(1)</td><td>await wait(1);</td></tr>
<tr><td>Vector3.new(0, 5, 0)</td><td>new Vector3(0, 5, 0)</td></tr>
<tr><td>part:Destroy()</td><td>part.Destroy();</td></tr>
<tr><td>if x then … end</td><td>if (x) { … }</td></tr>
<tr><td>while true do … end</td><td>while (true) { … await wait(); }</td></tr>
<tr><td>-- comment</td><td>// comment</td></tr>
<tr><td>nil / ~= / ..</td><td>null / !== / +</td></tr>
<tr><td>store:GetAsync(key)</td><td>await store.GetAsync(key)</td></tr>
</table>
<h4>Where scripts go</h4>
<ul><li><b>Inside a part</b> — <code>script.Parent</code> is that part.</li>
<li><b>ServerScriptService</b> — runs once when the game starts.</li>
<li><b>Inside a TextButton</b> — <code>script.Parent</code> is the button.</li></ul>
<h4>Things you can use</h4>
<ul>
<li><code>game.Players</code> — <code>LocalPlayer</code>, <code>PlayerAdded</code>, <code>GetPlayerFromCharacter(model)</code></li>
<li><code>player.Character</code> — <code>Humanoid</code> (Health, WalkSpeed, JumpPower, TakeDamage), <code>HumanoidRootPart</code>, <code>MoveTo(v)</code></li>
<li>Parts — <code>Position Size Orientation Color Material Transparency CanCollide Anchored Shape</code>, <code>Touched</code>, <code>Destroy() Clone()</code></li>
<li><code>Instance.new("Part" | "Folder" | "IntValue" | "ClickDetector" | "PointLight" | "Sound" | "TextLabel" | "Decal" | "ImageLabel" …)</code></li>
<li>Pictures — <code>decal.Texture = "pictureId"</code> (copy the id from 🖼 Decal ▸ your picture), <code>decal.Face = Enum.NormalId.Front</code>, <code>imageLabel.Image = "pictureId"</code></li>
<li><code>game.GetService("TweenService" | "RunService" | "Debris" | "Lighting" | "UserInputService" | "SoundService")</code></li>
<li><code>wait(s)</code>, <code>task.wait / task.spawn / task.delay</code>, <code>print / warn</code>, <code>math.random(1, 10)</code></li>
<li><code>Vector3 Color3 CFrame UDim2 TweenInfo BrickColor Enum</code></li>
<li><code>player.leaderstats</code> — a Folder named "leaderstats" with IntValues shows on the leaderboard</li>
<li>Saving — <code>const store = game.GetService("DataStoreService").GetDataStore("PlayerData")</code>, then <code>await store.GetAsync(key)</code>, <code>store.SetAsync(key, value)</code>, <code>UpdateAsync IncrementAsync RemoveAsync</code>. Use keys like <code>"Player_" + player.UserId</code>. Saves follow the player's account to every device (up to 50 KB per game); in a playtest they stay on this computer (Test ▸ Clear Saves).</li>
<li>Animating — <code>const anim = Instance.new("Animation"); anim.AnimationId = "wave";</code> (or dance, sit, cheer, point, clap, bow, salute, nod, shake, shrug, laugh, kick, punch, spin, flip, jumpingjacks, zombie…), then <code>const track = humanoid.Animator.LoadAnimation(anim); track.Play();</code> — <code>Stop() Looped Priority AdjustSpeed AdjustWeight TimePosition IsPlaying Ended GetMarkerReachedSignal(name)</code>. Your own: <code>anim.Keyframes = [{ Time: 0.5, RightArm: new Vector3(90, 0, 0), Lift: 1 }, …]</code> moving <code>Head Torso Body LeftArm RightArm LeftLeg RightLeg</code> (degrees). Everyone in the game sees your character's animations.</li>
<li>VR — players on a Meta Quest can play in VR (🥽 VR button). <code>UserInputService.VREnabled</code> tells you; controller buttons arrive in <code>InputBegan</code> as <code>Enum.KeyCode.ButtonA / ButtonB / ButtonX / ButtonY</code>, grips <code>ButtonL1 / ButtonR1</code>, triggers <code>ButtonL2 / ButtonR2</code>. On-screen buttons and ClickDetectors work with the laser pointer (or a pinch, with hand tracking). Chat typed on the VR keyboard reaches <code>player.Chatted</code> like any chat.</li>
<li>Selling — make game passes and developer products in <b>🛒 Paid Items</b> (Test tab), then use their ids: <code>await MarketplaceService.UserOwnsGamePassAsync(player.UserId, id)</code>, <code>PromptGamePassPurchase(player, id)</code>, <code>PromptProductPurchase(player, id)</code>, <code>PromptGamePassPurchaseFinished</code>, <code>MarketplaceService.ProcessReceipt = (receipt) =&gt; Enum.ProductPurchaseDecision.PurchaseGranted</code>. Players pay tokens in Neoblox's own buy window; you earn 70%. Playtest purchases are pretend.</li>
<li>Neoblox extras: <code>part.Gameplay = "KillBrick" | "Checkpoint" | "JumpPad"</code>, <code>player.GiveXP(10)</code></li>
</ul>
<p class="dim">Scripts run on each player's own device, in a safe sandbox. Errors show in the Output window — click one to jump to the line. In a published game, press F9 for the Developer Console.</p>`;

  // autocomplete words: the API's members and globals, plus words already in your script
  const API_WORDS = ('Connect Once Wait Disconnect Parent Name ClassName Position Size Orientation CFrame Color BrickColor Material Transparency CanCollide Anchored CanTouch Shape Gameplay ' +
    'Touched TouchEnded Destroy Clone FindFirstChild FindFirstChildOfClass FindFirstChildWhichIsA FindFirstAncestor WaitForChild GetChildren GetDescendants IsA IsDescendantOf ' +
    'GetAttribute SetAttribute GetPropertyChangedSignal Changed ChildAdded ChildRemoved Players LocalPlayer PlayerAdded PlayerRemoving GetPlayers GetPlayerFromCharacter Character ' +
    'CharacterAdded Humanoid HumanoidRootPart Health MaxHealth WalkSpeed JumpPower TakeDamage Died HealthChanged Jump MoveTo PivotTo GetPivot RespawnLocation Kick LoadCharacter GiveXP ' +
    'leaderstats Value Workspace GetService Lighting ClockTime TimeOfDay RunService Heartbeat RenderStepped Stepped TweenService Create Play Pause Cancel Completed Debris AddItem ' +
    'SoundService PlayLocalSound UserInputService InputBegan InputEnded IsKeyDown KeyCode UserInputType StarterGui SetCore SendNotification ChatMakeSystemMessage MouseButton1Click ' +
    'Activated Text Visible TextColor3 BackgroundColor3 TextSize MouseClick MaxActivationDistance Brightness Range Enabled Raycast Gravity AssemblyLinearVelocity Chatted ' +
    'fromRGB fromHex fromHSV fromScale fromOffset Angles lookAt Magnitude Unit Lerp Dot Cross EasingStyle EasingDirection Linear Sine Quad Cubic Bounce Elastic Back InOut ' +
    'PartType Ball Block Cylinder Wedge Plastic Neon Wood Slate Brick Metal Grass Sand Ice Glass SmoothPlastic ClickDetector PointLight IntValue NumberValue StringValue BoolValue ' +
    'Folder Model Part TextLabel TextButton ScreenGui Sound SoundId Volume BindableEvent RemoteEvent FireServer OnServerEvent Fire Event ReplicatedStorage ServerScriptService ' +
    'Decal Texture Face NormalId Front Back Left Right Top Bottom ImageLabel Image ' +
    'DataStoreService GetDataStore GetGlobalDataStore GetAsync SetAsync UpdateAsync IncrementAsync RemoveAsync BindToClose UserId DisplayName ' +
    'MarketplaceService UserOwnsGamePassAsync PromptGamePassPurchase PromptProductPurchase PromptGamePassPurchaseFinished PromptProductPurchaseFinished ProcessReceipt ' +
    'GetProductInfo ProductPurchaseDecision PurchaseGranted NotProcessedYet ProductId PlayerId PurchaseId CurrencySpent GetPlayerByUserId InfoType GamePass Product ' +
    'Animation AnimationId Keyframes Animator LoadAnimation AnimationTrack IsPlaying Looped Priority AnimationPriority AdjustSpeed AdjustWeight TimePosition Length ' +
    'WeightCurrent Ended Stopped DidLoop KeyframeReached GetMarkerReachedSignal GetTimeOfKeyframe GetPlayingAnimationTracks Time Lift Torso Body RightArm LeftArm RightLeg LeftLeg Action Idle Movement ' +
    'VREnabled GamepadEnabled ButtonA ButtonB ButtonX ButtonY ButtonL1 ButtonR1 ButtonL2 ButtonR2 Gamepad1').split(' ');
  const GLOBAL_WORDS = 'game workspace script Instance Vector3 Vector2 Color3 BrickColor CFrame UDim2 TweenInfo Enum RaycastParams wait task print warn math tick time spawn delay console const let function async await return if else for while true false null new break continue typeof'.split(' ');

  // ------------------------------------------------------------------ syntax highlighting
  const KW = new Set('const let var function async await return if else for while do break continue new class extends super try catch finally throw typeof instanceof in of switch case default this void delete yield static get set'.split(' '));
  const LIT = new Set(['true','false','null','undefined','NaN','Infinity']);
  const GLOB = new Set(['game','Game','workspace','Workspace','script','Instance','Vector3','Vector2','Color3','BrickColor','CFrame','UDim','UDim2','TweenInfo','Enum','RaycastParams',
    'wait','task','print','warn','error','math','Math','tick','time','delay','spawn','console','setTimeout','setInterval','clearTimeout','clearInterval','JSON','Object','Array','String','Number','Promise','Date']);
  const TOK = /(\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|("(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?|`(?:[^`\\]|\\[\s\S])*`?)|(\b(?:0x[0-9a-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b)|([A-Za-z_$][\w$]*)|(\s+)|([\s\S])/g;
  function highlight(src){
    let out = '', m, prevSig = '';
    TOK.lastIndex = 0;
    while((m = TOK.exec(src))){
      const t = m[0];
      if(m[1]) out += '<span class="c">' + esc(t) + '</span>';
      else if(m[2]) out += '<span class="s">' + esc(t) + '</span>';
      else if(m[3]) out += '<span class="n">' + t + '</span>';
      else if(m[4]){
        let cls = '';
        if(KW.has(t)) cls = 'k';
        else if(LIT.has(t)) cls = 'l';
        else if(prevSig === '.' && /^[A-Z]/.test(t)) cls = 'm';
        else if(GLOB.has(t) && prevSig !== '.') cls = 'g';
        else { const rest = src.slice(TOK.lastIndex, TOK.lastIndex + 40); if(/^\s*\(/.test(rest)) cls = 'f'; }
        out += cls ? '<span class="' + cls + '">' + t + '</span>' : t;
      }
      else if(m[5]) out += t;
      else out += '<span class="p">' + esc(t) + '</span>';
      if(!m[5]) prevSig = t;
    }
    return out;
  }

  // ------------------------------------------------------------------ tabs / owners
  // owner: { kind:'part', data } | { kind:'gui', u } | { kind:'world', s }
  const tabs = [];
  let active = null; // the open tab, or null for the 3D "Place" view
  const target = (o)=> o.kind==='part' ? o.data : o.kind==='gui' ? o.u : o.s;
  function codeOf(o){ if(o.kind==='world') return o.s.code || ''; const sc = target(o).script; return sc && sc.code || ''; }
  function setCodeOf(o, code){
    if(o.kind==='part') setPartScript(o.data, code);
    else if(o.kind==='gui') o.u.script = { lang:'js', code: String(code).slice(0, SCRIPT_CODE_MAXLEN) };
    else o.s.code = String(code).slice(0, SCRIPT_CODE_MAXLEN);
  }
  function alive(o){
    if(o.kind==='part') return !!(o.data.script && studioKeyOfData(o.data));
    if(o.kind==='gui') return !!(o.u.script && (App.studio.ui||[]).includes(o.u));
    return (App.studio.scripts||[]).includes(o.s);
  }
  function titleOf(o){
    if(o.kind==='part'){ const n = (o.data.props && o.data.props.nm) || (BLOCK_TYPE_BY_ID[o.data.type]||{}).label || 'Part'; return n + ' › Script'; }
    if(o.kind==='gui') return 'TextButton › Script';
    return o.s.name || 'Script';
  }
  CE.ownerOf = function(where, ref){
    if(!ref) return null;
    if(where==='part') return { kind:'part', data:ref };
    if(where==='gui') return { kind:'gui', u:ref };
    if(where==='world') return { kind:'world', s:ref };
    return null;
  };

  // ------------------------------------------------------------------ DOM
  let root, tabbar, main, ta, hl, gut, status, help, exMenu, ac;
  function build(){
    root = document.createElement('div');
    root.id = 'sdCode'; root.className = 'sd-code'; root.hidden = true;
    root.innerHTML = `
      <div class="ce-tabs" role="tablist"></div>
      <div class="ce-body">
        <div class="ce-tools">
          <button type="button" class="ce-tool" data-act="play" title="Play test (F5)">▶ Play</button>
          <div class="ce-drop"><button type="button" class="ce-tool" data-act="examples">Examples ▾</button><div class="ce-menu" hidden></div></div>
          <button type="button" class="ce-tool" data-act="help" title="How scripting works">❔ Help</button>
          <span class="ce-lang">JavaScript</span>
        </div>
        <div class="ce-main">
          <div class="ce-gutter"><div class="ce-gutter-in"></div></div>
          <div class="ce-area">
            <pre class="ce-hl" aria-hidden="true"></pre>
            <textarea class="ce-ta" spellcheck="false" autocapitalize="off" autocomplete="off" autocorrect="off" wrap="off" aria-label="Script code"></textarea>
            <div class="ce-ac" hidden></div>
          </div>
        </div>
        <div class="ce-status"><span class="ce-an"></span><span class="ce-pos"></span></div>
        <div class="ce-help" hidden><button type="button" class="ce-help-x" aria-label="Close">✕</button><div class="ce-help-body"></div></div>
      </div>`;
    (document.getElementById('studioIde') || document.body).appendChild(root);
    tabbar = $('.ce-tabs', root); main = $('.ce-body', root); ta = $('.ce-ta', root); hl = $('.ce-hl', root);
    gut = $('.ce-gutter-in', root); status = $('.ce-status', root); help = $('.ce-help', root); exMenu = $('.ce-menu', root); ac = $('.ce-ac', root);
    $('.ce-help-body', root).innerHTML = HELP;
    $('.ce-help-x', root).addEventListener('click', ()=>{ help.hidden = true; });
    root.addEventListener('click', (e)=>{
      const b = e.target.closest('[data-act]');
      if(!b) return;
      const act = b.dataset.act;
      if(act==='play'){ startStudioPlaytest(); }
      else if(act==='help'){ help.hidden = !help.hidden; }
      else if(act==='examples'){ e.stopPropagation(); renderExamples(); exMenu.hidden = !exMenu.hidden; }
    });
    document.addEventListener('click', (e)=>{ if(exMenu && !e.target.closest('.ce-drop')) exMenu.hidden = true; });
    ta.addEventListener('input', onInput);
    ta.addEventListener('scroll', syncScroll);
    ta.addEventListener('keydown', onKey);
    ta.addEventListener('keyup', updatePos);
    ta.addEventListener('click', ()=>{ updatePos(); hideAc(); });
    ta.addEventListener('blur', ()=> setTimeout(hideAc, 150));
    status.addEventListener('click', (e)=>{ const ln = e.target.closest('[data-line]'); if(ln) CE.gotoLine(+ln.dataset.line); });
  }
  function renderExamples(){
    const o = active && active.owner; const kind = o ? o.kind : 'part';
    const list = EXAMPLES.filter(x=> x.where === kind).concat(EXAMPLES.filter(x=> x.where !== kind));
    exMenu.innerHTML = '<div class="ce-menu-h">Replace this script with an example</div>' + list.map((x)=>`<button type="button" class="ce-mi${x.where===kind?'':' dim'}" data-ex="${EXAMPLES.indexOf(x)}">${esc(x.name)}<span>${x.where==='part'?'part':x.where==='gui'?'button':'ServerScriptService'}</span></button>`).join('');
    exMenu.querySelectorAll('[data-ex]').forEach(b=> b.addEventListener('click', ()=>{
      const ex = EXAMPLES[+b.dataset.ex];
      exMenu.hidden = true;
      ta.focus(); ta.select();
      insertText(ex.code);
      ta.setSelectionRange(0, 0); ta.scrollTop = 0;
      onInput();
      if(window.NeoStudioUI) NeoStudioUI.log('Inserted the "' + ex.name + '" example' + (ex.where !== (active && active.owner.kind) ? ' — it was written for a ' + (ex.where==='part' ? 'part' : ex.where==='gui' ? 'button' : 'ServerScriptService') + ' script' : ''));
    }));
  }

  function renderTabs(){
    // drop tabs whose script was deleted (or whose world was closed)
    for(let i = tabs.length - 1; i >= 0; i--) if(!alive(tabs[i].owner)){ if(active === tabs[i]) active = null; tabs.splice(i, 1); }
    if(!root) build();
    root.hidden = !tabs.length;
    document.body.classList.toggle('sd-code-on', !!active);
    if(!tabs.length){ return; }
    tabbar.innerHTML = `<button type="button" class="ce-tab${active?'':' on'}" data-tab="place"><span class="ic">🌐</span>${esc(App.studio.lastName || 'Place')}</button>` +
      tabs.map((t, i)=> `<button type="button" class="ce-tab${active===t?' on':''}" data-tab="${i}"><span class="ic">📜</span>${esc(titleOf(t.owner))}<span class="x" data-close="${i}" title="Close">✕</span></button>`).join('');
    tabbar.querySelectorAll('[data-tab]').forEach(b=> b.addEventListener('click', (e)=>{
      const c = e.target.closest('[data-close]');
      if(c){ e.stopPropagation(); closeTab(tabs[+c.dataset.close]); return; }
      const k = b.dataset.tab;
      activate(k==='place' ? null : tabs[+k]);
    }));
    main.hidden = !active;
  }
  function activate(tab){
    if(active && active !== tab) saveScroll();
    active = tab;
    renderTabs();
    if(!tab) return;
    ta.value = codeOf(tab.owner);
    help.hidden = true;
    paint();
    ta.scrollTop = tab.scroll || 0; ta.scrollLeft = 0;
    syncScroll();
    analyze(true);
    setTimeout(()=>{ try{ ta.focus({ preventScroll:true }); }catch(e){ ta.focus(); } updatePos(); }, 0);
  }
  function saveScroll(){ if(active) active.scroll = ta.scrollTop; }
  function closeTab(tab){
    const i = tabs.indexOf(tab); if(i < 0) return;
    tabs.splice(i, 1);
    if(active === tab) activate(tabs[i] || tabs[i-1] || null); else renderTabs();
  }
  CE.open = function(owner, line){
    if(!owner) return;
    if(!root) build();
    let tab = tabs.find(t=> t.owner.kind === owner.kind && target(t.owner) === target(owner));
    if(!tab){ tab = { owner, scroll:0 }; tabs.push(tab); }
    activate(tab);
    if(line) setTimeout(()=> CE.gotoLine(line), 0);
  };
  CE.openRef = function(where, ref, line){
    const o = CE.ownerOf(where, ref);
    if(!o) return;
    if(App.studio.testing) stopStudioPlaytest();
    if(!alive(o)){ showToast('That script isn\'t in the build anymore'); return; }
    CE.open(o, line);
  };
  CE.closeFor = function(owner){ tabs.slice().forEach(t=>{ if(t.owner.kind === owner.kind && target(t.owner) === target(owner)) closeTab(t); }); };
  CE.refresh = function(){ if(root) renderTabs(); };
  CE.showPlace = function(){ if(active){ saveScroll(); active = null; renderTabs(); } };
  CE.closeAll = function(){ tabs.length = 0; active = null; if(root) renderTabs(); };
  CE.isOpen = ()=> !!active;
  CE.example = (name)=> (EXAMPLES.find(x=> x.name === name) || {}).code || '';
  CE.help = function(){ if(!root) build(); if(!tabs.length){ showToast('Open a script first — insert one with 📜 Script'); } help.hidden = false; if(!active && tabs.length) activate(tabs[0]); };
  CE.gotoLine = function(n){
    if(!active) return;
    const lines = ta.value.split('\n');
    n = Math.max(1, Math.min(lines.length, n|0));
    let pos = 0; for(let i = 0; i < n-1; i++) pos += lines[i].length + 1;
    ta.focus();
    ta.setSelectionRange(pos, pos + lines[n-1].length);
    ta.scrollTop = Math.max(0, (n - 4) * LINE_H);
    syncScroll(); updatePos();
    const g = gut.children[n-1]; if(g){ g.classList.add('flash'); setTimeout(()=> g.classList.remove('flash'), 1200); }
  };

  // ------------------------------------------------------------------ editing
  let lastLines = -1, errLine = 0;
  function paint(){
    const v = ta.value;
    hl.innerHTML = highlight(v) + '\n ';
    const n = v.split('\n').length;
    if(n !== lastLines || gut.dataset.err !== String(errLine)){
      lastLines = n; gut.dataset.err = String(errLine);
      let h = ''; for(let i = 1; i <= n; i++) h += '<div' + (i===errLine ? ' class="err"' : '') + '>' + i + '</div>';
      gut.innerHTML = h;
    }
  }
  function syncScroll(){
    hl.style.transform = 'translate(' + (-ta.scrollLeft) + 'px,' + (-ta.scrollTop) + 'px)';
    gut.style.transform = 'translateY(' + (-ta.scrollTop) + 'px)';
    if(!ac.hidden) placeAc();
  }
  let explorerTimer = 0;
  function onInput(){
    if(!active) return;
    if(!alive(active.owner)){ renderTabs(); return; }
    if(ta.value.length > SCRIPT_CODE_MAXLEN){ ta.value = ta.value.slice(0, SCRIPT_CODE_MAXLEN); showToast('Scripts can be up to ' + SCRIPT_CODE_MAXLEN + ' characters'); }
    setCodeOf(active.owner, ta.value);
    paint(); syncScroll(); updatePos();
    analyze();
    suggest();
    clearTimeout(explorerTimer);
    explorerTimer = setTimeout(()=>{ if(window.renderStudioExplorer) renderStudioExplorer(); }, 600);
  }
  function updatePos(){
    const v = ta.value, p = ta.selectionStart;
    const before = v.slice(0, p);
    const line = before.split('\n').length, col = p - before.lastIndexOf('\n');
    $('.ce-pos', status).textContent = 'Ln ' + line + ', Col ' + col;
  }
  // Insert text at the cursor the way typing would, so Ctrl/⌘+Z can undo it.
  function insertText(t){
    ta.focus();
    let ok = false;
    try{ ok = document.execCommand('insertText', false, t); }catch(e){ ok = false; }
    if(!ok){ const s = ta.selectionStart, e = ta.selectionEnd; ta.setRangeText(t, s, e, 'end'); }
  }
  function lineStart(v, p){ return v.lastIndexOf('\n', p - 1) + 1; }
  function onKey(e){
    e.stopPropagation();
    const mod = e.ctrlKey || e.metaKey;
    if(!ac.hidden){
      if(e.key==='ArrowDown' || e.key==='ArrowUp'){ e.preventDefault(); moveAc(e.key==='ArrowDown' ? 1 : -1); return; }
      if(e.key==='Enter' || e.key==='Tab'){ e.preventDefault(); acceptAc(); return; }
      if(e.key==='Escape'){ e.preventDefault(); hideAc(); return; }
    }
    if(e.key==='F5'){ e.preventDefault(); startStudioPlaytest(); return; }
    if(mod && (e.key==='s' || e.key==='S')){ e.preventDefault(); if(window.NeoStudioUI) NeoStudioUI.log('Saved "' + (active ? titleOf(active.owner) : 'script') + '" — it\'s part of your place (Publish to share it)', 'ok'); return; }
    if(mod && e.key==='/'){ e.preventDefault(); toggleComment(); return; }
    if(mod && e.key===' '){ e.preventDefault(); suggest(true); return; }
    const v = ta.value, s = ta.selectionStart, en = ta.selectionEnd;
    if(e.key==='Tab'){
      e.preventDefault();
      if(s === en && !e.shiftKey){ insertText('  '); return; }
      indentLines(e.shiftKey ? -1 : 1);
      return;
    }
    if(e.key==='Enter' && !mod && !e.shiftKey && !e.altKey){
      e.preventDefault();
      const ls = lineStart(v, s);
      const cur = v.slice(ls, s);
      const indent = (cur.match(/^[ \t]*/) || [''])[0];
      const opens = /[{(\[]\s*$/.test(cur);
      const closes = /^\s*[}\])]/.test(v.slice(en));
      if(opens && closes) { insertText('\n' + indent + '  \n' + indent); const p = ta.selectionStart - indent.length - 1; ta.setSelectionRange(p, p); }
      else insertText('\n' + indent + (opens ? '  ' : ''));
      onInput();
      return;
    }
    if((e.key==='}' || e.key===']' || e.key===')') && s === en){
      const ls = lineStart(v, s);
      if(/^[ \t]+$/.test(v.slice(ls, s)) && (s - ls) >= 2){
        e.preventDefault();
        ta.setSelectionRange(s - 2, s);
        insertText(e.key);
        return;
      }
    }
  }
  function indentLines(dir){
    const v = ta.value, s = ta.selectionStart, en = ta.selectionEnd;
    const a = lineStart(v, s), b = v.indexOf('\n', Math.max(en - 1, s)); const end = b === -1 ? v.length : b;
    const block = v.slice(a, end).split('\n');
    const out = block.map(l=> dir > 0 ? '  ' + l : l.replace(/^ {1,2}|^\t/, '')).join('\n');
    ta.setSelectionRange(a, end);
    insertText(out);
    ta.setSelectionRange(a, a + out.length);
    onInput();
  }
  function toggleComment(){
    const v = ta.value, s = ta.selectionStart, en = ta.selectionEnd;
    const a = lineStart(v, s), b = v.indexOf('\n', Math.max(en - 1, s)); const end = b === -1 ? v.length : b;
    const block = v.slice(a, end).split('\n');
    const all = block.every(l=> !l.trim() || /^\s*\/\//.test(l));
    const out = block.map(l=> !l.trim() ? l : all ? l.replace(/^(\s*)\/\/ ?/, '$1') : l.replace(/^(\s*)/, '$1// ')).join('\n');
    ta.setSelectionRange(a, end);
    insertText(out);
    ta.setSelectionRange(a, a + out.length);
    onInput();
  }

  // ------------------------------------------------------------------ autocomplete
  let acList = [], acSel = 0, acWord = null;
  function currentWord(){
    const v = ta.value, p = ta.selectionStart;
    if(p !== ta.selectionEnd) return null;
    const m = /[A-Za-z_$][\w$]*$/.exec(v.slice(Math.max(0, p - 40), p));
    const word = m ? m[0] : '';
    const before = v.slice(0, p - word.length);
    const afterDot = /\.\s*$/.test(before);
    return { word, start: p - word.length, afterDot };
  }
  function suggest(force){
    const w = currentWord();
    if(!w || (!force && (w.word.length < (w.afterDot ? 1 : 2)))){ hideAc(); return; }
    // inside a string or comment? don't suggest
    const lineBefore = ta.value.slice(lineStart(ta.value, w.start), w.start);
    if(/\/\//.test(lineBefore) || (lineBefore.split('"').length % 2 === 0) || (lineBefore.split("'").length % 2 === 0)){ hideAc(); return; }
    const pool = new Set(w.afterDot ? API_WORDS : GLOBAL_WORDS.concat(API_WORDS));
    (ta.value.match(/[A-Za-z_$][\w$]{2,}/g) || []).slice(0, 3000).forEach(x=> pool.add(x));
    const lw = w.word.toLowerCase();
    acList = Array.from(pool).filter(x=> x !== w.word && x.toLowerCase().startsWith(lw)).sort((a, b)=> a.length - b.length || a.localeCompare(b)).slice(0, 8);
    if(!acList.length){ hideAc(); return; }
    acWord = w; acSel = 0;
    ac.innerHTML = acList.map((x, i)=> `<div class="ce-ac-i${i===0?' on':''}" data-i="${i}"><b>${esc(x.slice(0, w.word.length))}</b>${esc(x.slice(w.word.length))}</div>`).join('');
    ac.querySelectorAll('[data-i]').forEach(d=> d.addEventListener('mousedown', (e)=>{ e.preventDefault(); acSel = +d.dataset.i; acceptAc(); }));
    ac.hidden = false;
    placeAc();
  }
  function placeAc(){
    if(!acWord) return;
    const v = ta.value.slice(0, acWord.start);
    const line = v.split('\n').length - 1, col = acWord.start - lineStart(ta.value, acWord.start);
    const cw = charWidth();
    ac.style.left = Math.max(0, 10 + col * cw - ta.scrollLeft) + 'px';
    ac.style.top = (8 + (line + 1) * LINE_H - ta.scrollTop + 2) + 'px';
  }
  let cwCache = 0;
  function charWidth(){
    if(cwCache) return cwCache;
    const s = document.createElement('span'); s.className = 'ce-measure'; s.textContent = 'x'.repeat(100);
    hl.parentNode.appendChild(s); cwCache = s.getBoundingClientRect().width / 100 || 7.2; s.remove();
    return cwCache;
  }
  function moveAc(d){ acSel = (acSel + d + acList.length) % acList.length; ac.querySelectorAll('.ce-ac-i').forEach((el, i)=> el.classList.toggle('on', i===acSel)); }
  function acceptAc(){
    const w = acWord, pick = acList[acSel];
    hideAc();
    if(!w || !pick) return;
    ta.setSelectionRange(w.start, ta.selectionStart);
    insertText(pick);
    onInput(); hideAc();
  }
  function hideAc(){ if(ac){ ac.hidden = true; } acWord = null; }

  // ------------------------------------------------------------------ Script Analysis
  let anTimer = 0, anSeq = 0;
  function analyze(now){
    clearTimeout(anTimer);
    anTimer = setTimeout(()=>{
      if(!active || !window.NeoScript) return;
      const my = ++anSeq, code = ta.value;
      NeoScript.check(code).then(r=>{
        if(my !== anSeq || !active) return;
        const an = $('.ce-an', status);
        if(r.ok){ errLine = 0; an.className = 'ce-an ok'; an.textContent = r.offline ? '' : '✓ No problems found'; }
        else { errLine = r.line; an.className = 'ce-an bad'; an.innerHTML = '<span data-line="' + (r.line|0) + '">✕ Line ' + (r.line|0) + ': ' + esc(r.message) + '</span>'; }
        lastLines = -1; paint();
      });
    }, now ? 0 : 450);
  }

  // ------------------------------------------------------------------ hooks into the editor
  function wire(){
    const wrap = (name, after, before)=>{ const f = window[name]; if(typeof f!=='function') return; window[name] = function(){ if(before) try{ before.apply(this, arguments); }catch(e){} const r = f.apply(this, arguments); try{ if(after) after.apply(this, arguments); }catch(e){} return r; }; };
    // play from anywhere: show the game, not the code
    wrap('startStudioPlaytest', null, ()=>{ CE.showPlace(); hideAc(); });
    // a different place loaded / a new place: the old place's scripts are gone
    wrap('loadWorldIntoStudio', ()=> CE.closeAll());
    wrap('goToStudio', ()=> CE.refresh());
    wrap('removeStudioBlock', ()=> CE.refresh());
    wrap('removeStudioUi', ()=> CE.refresh());
    const clear = document.getElementById('btnClearWorld'); if(clear) clear.addEventListener('click', ()=> setTimeout(()=> CE.closeAll(), 0));
    window.addEventListener('resize', ()=>{ cwCache = 0; });
  }
  document.addEventListener('DOMContentLoaded', ()=> setTimeout(wire, 0));
})();
