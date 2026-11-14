$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$fixtureRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../verification'))
New-Item -ItemType Directory -Force -Path $fixtureRoot | Out-Null
$fixtureCases = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'voice-fixtures.json') -Raw | ConvertFrom-Json
$fixtureSynth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$fixtureFormat = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
try {
  $fixtureVoices = @($fixtureSynth.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -eq 'en-US' })
  if ($fixtureVoices.Count -eq 0) { throw 'An installed English Windows voice is required.' }
  $fixtureSynth.Rate = -1
  $fixtureSynth.SelectVoice($fixtureVoices[0].VoiceInfo.Name)
  $fixtureSynth.SetOutputToWaveFile((Join-Path $fixtureRoot 'speech-prefix.wav'), $fixtureFormat)
  $fixtureSynth.Speak('Hey Kaji')
  $fixtureSynth.SetOutputToNull()
  foreach ($fixtureCase in $fixtureCases) {
    $fixtureSynth.SetOutputToWaveFile((Join-Path $fixtureRoot ("speech-command-" + $fixtureCase.id + '.wav')), $fixtureFormat)
    $fixtureSynth.Speak($fixtureCase.phrase)
    $fixtureSynth.SetOutputToNull()
  }
  Write-Output ('Generated local speech fixtures with ' + $fixtureVoices[0].VoiceInfo.Name + '. No provider synthesis calls.')
} finally { $fixtureSynth.Dispose() }
